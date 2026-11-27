import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const toggle = fileURLToPath(new URL("../herdr/toggle.mjs", import.meta.url));

// A stand-in for the herdr CLI: each session (socket) numbers its panes from w1:p2, as real sessions do, and closes
// only its own plugin panes.
const fakeHerdr = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const file = join(process.env.FAKE_HERDR_DIR, encodeURIComponent(process.env.HERDR_SOCKET_PATH) + ".json");
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { next: 2, panes: [] };
const args = process.argv.slice(2).join(" ");
const save = () => writeFileSync(file, JSON.stringify(state));
if (args.startsWith("plugin pane open")) {
  const id = "w1:p" + state.next++;
  state.panes.push(id); save();
  console.log(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: id } } } }));
} else if (args.startsWith("plugin pane close")) {
  const id = process.argv.at(-1);
  if (!state.panes.includes(id)) { console.error("plugin pane not found"); process.exit(1); }
  state.panes = state.panes.filter(pane => pane !== id); save();
} else if (args.startsWith("pane layout")) {
  console.log(JSON.stringify({ result: { layout: { panes: [{ pane_id: process.argv.at(-1), rect: { width: 60 } }] } } }));
} else if (args.startsWith("pane resize")) {
  state.resized = process.argv.slice(2); save();
} else process.exit(2);
`;

test("the Herdr toggle closes only the view its own session opened, though sessions share a state directory", { skip: process.platform === "win32" && "the plugin runs on Linux and macOS" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-herdr-")), fake = join(dir, "herdr"), states = join(dir, "state");
  writeFileSync(fake, fakeHerdr);
  chmodSync(fake, 0o755);
  try {
    const run = (socket: string) => execFileSync(process.execPath, [toggle], {
      env: { ...process.env, HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: states, HERDR_SOCKET_PATH: socket, FAKE_HERDR_DIR: dir },
    });
    const session = (socket: string) => {
      const file = join(dir, `${encodeURIComponent(socket)}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { panes: [] };
    };
    const alpha = "/run/herdr/sessions/alpha/herdr.sock", beta = "/run/herdr/sessions/beta/herdr.sock";
    run(alpha);
    run(beta);
    assert.deepEqual([session(alpha).panes, session(beta).panes], [["w1:p2"], ["w1:p2"]], "both sessions open a view, with the same pane ID");
    assert.deepEqual(session(alpha).resized, ["pane", "resize", "--pane", "w1:p2", "--direction", "right", "--amount", String(20 / 120)], "narrowed to 40 columns");
    run(alpha);
    assert.deepEqual([session(alpha).panes, session(beta).panes], [[], ["w1:p2"]], "alpha's toggle closes alpha's view only");
    run(beta);
    assert.deepEqual(session(beta).panes, [], "beta still knows its own view");
    assert.deepEqual(readdirSync(states), [], "a closed view leaves no saved ID");

    // Quit with Ctrl-C: the saved ID is stale, Herdr refuses to close it, and the toggle opens a new view.
    run(alpha);
    writeFileSync(join(dir, `${encodeURIComponent(alpha)}.json`), JSON.stringify({ ...session(alpha), panes: [] }));
    run(alpha);
    assert.deepEqual(session(alpha).panes, ["w1:p4"]);
    assert.equal(readdirSync(states).length, 1, "one saved ID per session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
