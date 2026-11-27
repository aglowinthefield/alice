// `alice service`: runs this checkout as a background service that starts at login (or boot, with lingering),
// restarts on failure, and checks for updates every 2 minutes. systemd user units on Linux, launchd agents on macOS.
// Settings live in one env file both service managers read, so reinstalling never loses them.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ACTIONS = ["install", "uninstall", "start", "stop", "restart", "status", "logs"];
const LABEL = "dev.alice.server", UPDATE_LABEL = "dev.alice.update";
const NAMES = { service: "alice.service", update: "alice-update.service", timer: "alice-update.timer", label: LABEL, updateLabel: UPDATE_LABEL, logs: "alice" };

/**
 * Every path the service uses, from the environment, so tests can point them at a temporary home.
 */
export function servicePaths(env = process.env, platform = process.platform) {
  const home = env.HOME || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const node = process.execPath;
  const units = platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(config, "systemd", "user");
  return {
    root, node, npm: join(dirname(node), "npm"),
    envFile: join(config, "alice", "alice.env"),
    units, unitFile: join(units, platform === "darwin" ? `${LABEL}.plist` : NAMES.service), names: NAMES,
    logs: join(home, "Library", "Logs", NAMES.logs),
    home,
  };
}

/**
 * The PATH the service runs with. A service manager starts with a bare PATH, so keep the directories that hold node
 * and the tools Alice runs, as they resolve now. Moving any of them means running install again; doctor says so.
 */
export function servicePath(paths, env = process.env) {
  const found = ["pi", "wt", "gh", "git"].map(bin => env[`ALICE_${bin.toUpperCase()}_BIN`] || bin).map(bin => {
    if (bin.includes("/")) return dirname(bin);
    const result = spawnSync("sh", ["-c", 'command -v "$0"', bin], { encoding: "utf8", env });
    return result.status === 0 ? dirname(result.stdout.trim()) : null;
  });
  const dirs = [dirname(paths.node), ...found, join(paths.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

export function envFileText(host) {
  return `# Alice server settings. The service reads this file when it starts; restart it after a change.
# Every variable is described in docs/reference.md.
ALICE_SERVE_UI=1
ALICE_HOST=${host}
# ALICE_PORT=4317
# Hostnames other than the bind address that may reach the server, comma-separated (for example a tailnet name).
# ALICE_ALLOWED_HOSTS=
`;
}

/** systemd user units: the server, and a timer that fetches updates every 2 minutes. */
export function systemdUnits(paths, path) {
  const service = `# Written by alice service install; it rewrites this file. Put your own changes in alice.service.d/.
[Unit]
Description=Alice
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${paths.root}
Environment=PATH=${path}
EnvironmentFile=-${paths.envFile}
ExecStart=${paths.npm} start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  const update = `# Written by alice service install.
[Unit]
Description=Check for Alice updates

[Service]
Type=oneshot
WorkingDirectory=${paths.root}
Environment=PATH=${path}
EnvironmentFile=-${paths.envFile}
ExecStart=${join(paths.root, "scripts", "update.sh")}
`;
  const timer = `# Written by alice service install.
[Unit]
Description=Check for Alice updates every 2 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
`;
  return { "alice.service": service, "alice-update.service": update, "alice-update.timer": timer };
}

const xml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// launchd has no EnvironmentFile, so a shell loads the env file and then becomes the command.
const withEnv = command => `set -a; [ -f "$0" ] && . "$0"; set +a; exec ${command}`;

function plist(label, paths, path, command, extra) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>${xml(withEnv(command))}</string><string>${xml(paths.envFile)}</string></array>
  <key>WorkingDirectory</key><string>${xml(paths.root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
${extra}
  <key>StandardOutPath</key><string>${xml(join(paths.logs, `${label === LABEL ? "server" : "update"}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logs, `${label === LABEL ? "server" : "update"}.log`))}</string>
</dict>
</plist>
`;
}

/** launchd agents: the server, kept alive, and the update check every 2 minutes. */
export function launchdAgents(paths, path) {
  return {
    [`${LABEL}.plist`]: plist(LABEL, paths, path, `"${paths.npm}" start`, "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>"),
    [`${UPDATE_LABEL}.plist`]: plist(UPDATE_LABEL, paths, path, `"${join(paths.root, "scripts", "update.sh")}"`, "  <key>StartInterval</key><integer>120</integer>"),
  };
}

function exec(bin, args, { inherit = false, allowFail = false } = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
  if (result.error) throw new Error(`${bin} could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) throw new Error(`${bin} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return Object.keys(files).map(name => join(dir, name));
}

function ensureEnvFile(paths, host, log) {
  if (existsSync(paths.envFile)) {
    if (host) log(`Kept ${paths.envFile}; --host applies only when it is created. Edit ALICE_HOST there.`);
    else log(`Kept ${paths.envFile}.`);
    return;
  }
  mkdirSync(dirname(paths.envFile), { recursive: true });
  writeFileSync(paths.envFile, envFileText(host || "127.0.0.1"));
  log(`Wrote ${paths.envFile}.`);
}

// The service serves dist/, and later updates build it themselves, so only a fresh checkout needs this.
function buildUi(paths, log) {
  if (existsSync(join(paths.root, "dist", "index.html"))) return;
  log("Building the UI into dist/…");
  const result = spawnSync("npx", ["vite", "build"], { cwd: paths.root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("The UI build failed; fix it, then run install again");
}

const ACTIVE_RUNS = "This stops the server at once and ends any active runs.";

/** Runs one `alice service` action. `log` prints one line. */
export function service(action, { host, yes = false, env = process.env, platform = process.platform, log = console.log } = {}) {
  if (platform !== "linux" && platform !== "darwin") throw new Error("alice service supports Linux (systemd) and macOS (launchd). On Windows, start `npm start` from Task Scheduler at logon; see docs/reference.md.");
  if ((action === "stop" || action === "uninstall") && !yes) throw new Error(`${ACTIVE_RUNS} Repeat with --yes to confirm.`);
  const paths = servicePaths(env, platform);
  return platform === "linux" ? systemd(action, paths, { host, env, log }) : launchd(action, paths, { host, env, log });
}

function systemd(action, paths, { host, env, log }) {
  const ctl = (...args) => exec("systemctl", ["--user", ...args]);
  const { service, update, timer } = paths.names;
  const active = () => exec("systemctl", ["--user", "is-active", "--quiet", service], { allowFail: true }).status === 0;
  if (action === "install") {
    ensureEnvFile(paths, host, log);
    buildUi(paths, log);
    for (const file of writeFiles(paths.units, systemdUnits(paths, servicePath(paths, env)))) log(`Wrote ${file}.`);
    ctl("daemon-reload");
    ctl("enable", "--now", timer);
    // Restarting a running server here would end its runs, so the new unit waits for the next update or restart.
    if (active()) { ctl("enable", service); log("Alice is already running; the new unit applies at its next restart (alice service restart waits for active runs)."); }
    else { ctl("enable", "--now", service); log("Started Alice."); }
    const linger = exec("loginctl", ["show-user", userInfo().username, "-p", "Linger", "--value"], { allowFail: true });
    if (linger.stdout?.trim() === "no") log("Alice starts when you log in. To start it at boot and keep it running after logout, run: loginctl enable-linger");
  } else if (action === "uninstall") {
    exec("systemctl", ["--user", "disable", "--now", service, timer], { allowFail: true });
    for (const name of [service, update, timer]) rmSync(join(paths.units, name), { force: true });
    ctl("daemon-reload");
    log(`Removed the Alice units. Settings stay in ${paths.envFile}, and data in the data directory.`);
  } else if (action === "start") { ctl("start", service); log("Started Alice."); }
  else if (action === "stop") { ctl("stop", service); log("Stopped Alice. It starts again at your next login unless you uninstall it."); }
  // SIGUSR2 drains: no new runs, wait for the active ones, then exit, and Restart=always brings it back.
  else if (action === "restart") {
    if (!active()) { ctl("start", service); log("Alice was not running; started it."); }
    else { ctl("kill", "--signal=SIGUSR2", service); log("Alice restarts once its active runs finish. The board shows it draining until then."); }
  } else if (action === "status") exec("systemctl", ["--user", "status", "--no-pager", service, timer], { inherit: true, allowFail: true });
  else if (action === "logs") exec("journalctl", ["--user", "-u", service, "-n", "200", "--no-pager"], { inherit: true });
}

function launchd(action, paths, { host, env, log }) {
  const { label: serverLabel, updateLabel } = paths.names;
  const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
  const loaded = label => exec("launchctl", ["print", `${domain}/${label}`], { allowFail: true }).status === 0;
  const agents = launchdAgents(paths, servicePath(paths, env));
  const plistPath = label => join(paths.units, `${label}.plist`);
  if (action === "install") {
    ensureEnvFile(paths, host, log);
    buildUi(paths, log);
    mkdirSync(paths.logs, { recursive: true });
    for (const file of writeFiles(paths.units, agents)) log(`Wrote ${file}.`);
    exec("launchctl", ["bootout", `${domain}/${updateLabel}`], { allowFail: true });
    exec("launchctl", ["bootstrap", domain, plistPath(updateLabel)]);
    if (loaded(serverLabel)) log("Alice is already running; the new agent applies at its next restart (alice service restart waits for active runs).");
    else { exec("launchctl", ["bootstrap", domain, plistPath(serverLabel)]); log("Started Alice."); }
  } else if (action === "uninstall") {
    for (const label of [serverLabel, updateLabel]) { exec("launchctl", ["bootout", `${domain}/${label}`], { allowFail: true }); rmSync(plistPath(label), { force: true }); }
    log(`Removed the Alice agents. Settings stay in ${paths.envFile}, and data in the data directory.`);
  } else if (action === "start") {
    if (loaded(serverLabel)) exec("launchctl", ["kickstart", `${domain}/${serverLabel}`]);
    else exec("launchctl", ["bootstrap", domain, plistPath(serverLabel)]);
    log("Started Alice.");
  } else if (action === "stop") { exec("launchctl", ["bootout", `${domain}/${serverLabel}`]); log("Stopped Alice. It starts again at your next login unless you uninstall it."); }
  // KeepAlive brings the server back after the drain ends.
  else if (action === "restart") { exec("launchctl", ["kill", "SIGUSR2", `${domain}/${serverLabel}`]); log("Alice restarts once its active runs finish. The board shows it draining until then."); }
  else if (action === "status") {
    for (const label of [serverLabel, updateLabel]) log(`${label}\t${loaded(label) ? "loaded" : "not loaded"}`);
  } else if (action === "logs") {
    const file = join(paths.logs, "server.log");
    if (!existsSync(file)) throw new Error(`No log yet at ${file}`);
    log(readFileSync(file, "utf8").split("\n").slice(-200).join("\n"));
  }
}

/** doctor's row for the service: installed or not, and whether its node and npm still exist. */
export function serviceCheck(env = process.env, platform = process.platform) {
  if (platform !== "linux" && platform !== "darwin") return null;
  const paths = servicePaths(env, platform);
  const file = paths.unitFile;
  if (!existsSync(file)) return { status: "info", name: "service", detail: "not installed; alice service install keeps the server running and up to date" };
  const text = readFileSync(file, "utf8");
  const npm = platform === "linux" ? /^ExecStart=(\S+) start$/m.exec(text)?.[1] : /exec "([^"]+)" start/.exec(text)?.[1];
  if (npm && !existsSync(npm)) return { status: "fail", name: "service", detail: `${file} runs ${npm}, which no longer exists; run alice service install again` };
  return { status: "pass", name: "service", detail: file };
}
