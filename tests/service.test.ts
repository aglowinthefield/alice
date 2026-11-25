import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/bakery-cli.mjs", import.meta.url));
const service = await import(new URL("../scripts/service.mjs", import.meta.url).href);

/** A temporary home with fake systemctl, loginctl and journalctl that log their arguments. */
function home(active: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-service-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  for (const name of ["systemctl", "loginctl", "journalctl", "npx"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\ncase "$*" in *is-active*) exit ${active ? 0 : 3};; *Linger*) echo no;; esac\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "service", ...args], {
    encoding: "utf8", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { dir, run, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("service install writes the units and env file, starts a stopped server, and keeps an existing env file", { skip: process.platform !== "linux" }, () => {
  const h = home(false);
  try {
    const first = h.run("install", "--host", "100.64.0.10");
    assert.equal(first.status, 0, first.stderr);
    const units = join(h.dir, "config", "systemd", "user");
    const unit = readFileSync(join(units, "bakery.service"), "utf8");
    assert.match(unit, new RegExp(`^ExecStart=${join(process.execPath, "..", "npm").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} start$`, "m"));
    assert.match(unit, /^EnvironmentFile=-.*\/config\/bakery\/bakery\.env$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.doesNotMatch(unit, /KillMode/, "default control-group cleanup stays");
    assert.ok(existsSync(join(units, "bakery-update.timer")));
    const envFile = join(h.dir, "config", "bakery", "bakery.env");
    assert.match(readFileSync(envFile, "utf8"), /^BAKERY_HOST=100\.64\.0\.10$/m);
    assert.deepEqual(h.calls().filter(line => line.startsWith("systemctl")), [
      "systemctl --user daemon-reload",
      "systemctl --user enable --now bakery-update.timer",
      "systemctl --user is-active --quiet bakery.service",
      "systemctl --user enable --now bakery.service",
    ]);
    assert.match(first.stdout, /loginctl enable-linger/);

    writeFileSync(envFile, "BAKERY_HOST=10.0.0.1\n");
    const again = h.run("install", "--host", "127.0.0.1");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(envFile, "utf8"), "BAKERY_HOST=10.0.0.1\n");
    assert.match(again.stdout, /Kept .*bakery\.env; --host applies only when it is created/);
  } finally { h.cleanup(); }
});

test("service install and restart never end the runs of a running server", { skip: process.platform !== "linux" }, () => {
  const h = home(true);
  try {
    assert.equal(h.run("install").status, 0);
    const calls = h.calls();
    assert.ok(calls.includes("systemctl --user enable bakery.service"));
    assert.ok(!calls.some(line => /restart|enable --now bakery\.service/.test(line)));
    const restart = h.run("restart");
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(h.calls().at(-1), "systemctl --user kill --signal=SIGUSR2 bakery.service");
  } finally { h.cleanup(); }
});

test("service stop and uninstall need --yes; uninstall keeps the env file", { skip: process.platform !== "linux" }, () => {
  const h = home(true);
  try {
    assert.equal(h.run("install").status, 0);
    const refused = h.run("uninstall");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /ends any active runs\. Repeat with --yes/);
    assert.equal(h.run("uninstall", "--yes").status, 0);
    assert.ok(!existsSync(join(h.dir, "config", "systemd", "user", "bakery.service")));
    assert.ok(existsSync(join(h.dir, "config", "bakery", "bakery.env")));
  } finally { h.cleanup(); }
});

test("launchd agents load the env file through a shell and keep the server alive", () => {
  const paths = { root: "/opt/bakery", node: "/n/bin/node", npm: "/n/bin/npm", envFile: "/h/.config/bakery/bakery.env", units: "/h/Library/LaunchAgents", logs: "/h/Library/Logs/bakery", home: "/h" };
  const agents = service.launchdAgents(paths, "/n/bin:/usr/bin");
  const server = agents["dev.bakery.server.plist"];
  assert.match(server, /<string>set -a; \[ -f "\$0" \] &amp;&amp; \. "\$0"; set \+a; exec "\/n\/bin\/npm" start<\/string><string>\/h\/\.config\/bakery\/bakery\.env<\/string>/);
  assert.match(server, /<key>KeepAlive<\/key><true\/>/);
  assert.match(agents["dev.bakery.update.plist"], /<key>StartInterval<\/key><integer>120<\/integer>/);
});

test("doctor's service check fails when the unit's npm is gone", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-service-"));
  try {
    const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "config") };
    assert.equal(service.serviceCheck(env, "linux").status, "info");
    const units = join(dir, "config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    writeFileSync(join(units, "bakery.service"), "[Service]\nExecStart=/gone/npm start\n");
    assert.match(service.serviceCheck(env, "linux").detail, /\/gone\/npm, which no longer exists; run bakery-cli service install again/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
