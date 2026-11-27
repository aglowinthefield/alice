#!/usr/bin/env node
// The alice plugin's toggle action: closes the running view this Herdr session opened, otherwise opens it as a split
// to the right of the focused pane and narrows it to the 40 columns `alice running` is laid out for.
//
// Named sessions share the plugin's state directory and number their panes alike, so the saved pane ID is kept per
// session, keyed by its socket, and only this action writes it. An ID gone stale (the view was quit with Ctrl-C, or
// Herdr restarted) fails to close, since Herdr closes only plugin panes, and a new view opens instead.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const herdr = (...args) => execFileSync(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const dir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!dir) {
  console.error("Run this through Herdr: herdr plugin action invoke toggle --plugin alice");
  process.exit(2);
}
const session = createHash("sha256").update(process.env.HERDR_SOCKET_PATH ?? "").digest("hex").slice(0, 16);
const state = join(dir, `pane-${session}`);
let open = "";
try { open = readFileSync(state, "utf8").trim(); } catch { /* not open */ }
rmSync(state, { force: true });
if (open) {
  try { herdr("plugin", "pane", "close", open); process.exit(0); }
  catch { /* Stale: open a new view. */ }
}
const id = JSON.parse(herdr("plugin", "pane", "open", "--plugin", "alice", "--entrypoint", "running", "--placement", "split", "--direction", "right", "--no-focus"))
  .result.plugin_pane.pane.pane_id;
mkdirSync(dir, { recursive: true });
writeFileSync(state, `${id}\n`);
const width = JSON.parse(herdr("pane", "layout", "--pane", id)).result.layout.panes.find(pane => pane.pane_id === id)?.rect.width ?? 0;
// Herdr splits the focused pane in half, so the split is twice the new pane's width; --amount moves its ratio.
if (width > 40) herdr("pane", "resize", "--pane", id, "--direction", "right", "--amount", String((width - 40) / (2 * width)));
