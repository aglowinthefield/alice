// Runs one Pi process for a card run, detached from the server, so the run outlives a server restart or crash.
//
//   node server/run-shim.ts <run dir> <command> [args...]
//
// Pi's stdout goes to `<run dir>/events.jsonl` and its stderr to `stderr.log`; the server tails those files. When Pi
// exits, the shim writes `exit.json` ({ code, signal }; { error } when Pi could not start; `started: false` when a
// stop arrived before Pi started) through a rename, so a reader never sees half of it. The worker spawns the shim
// detached, which makes it a process group leader; Pi and its tools inherit that group, so signalling the group stops
// the whole run. The shim stays to record Pi's exit.
//
// Startup is gated: the shim prints `ready` once its signal handlers are installed (and `stopping` when a stop arrives
// before Pi starts), then waits for `start` on stdin, which the worker sends only after it has saved the shim's PID
// and start time. If stdin closes first (the worker died, or could not identify the shim), the shim exits without
// starting Pi, so no Pi ever runs untracked.
//
// Node built-ins only: the shim runs as plain `node` with type stripping, without the server's loader. Linux and
// macOS only; other platforms pipe Pi into the server.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunExit = { code: number | null; signal: string | null; error?: string; started?: false };

const [runDir, bin, ...args] = process.argv.slice(2);
if (!runDir || !bin) {
  console.error("usage: run-shim.ts <run dir> <command> [args...]");
  process.exit(2);
}

let child: ChildProcess | undefined;
/** A stop that arrived before Pi started; Pi is then never started. */
let cancelled: NodeJS.Signals | null = null;
let written = false;

function record(exit: RunExit) {
  if (written) return;
  written = true;
  const file = join(runDir, "exit.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(exit));
  renameSync(`${file}.tmp`, file);
  process.exit(0);
}

// A group signal reaches the shim and Pi alike. Node runs this handler on a later loop turn, so a signal sent just
// before Pi was forked can land here after the spawn; forwarding it makes sure Pi gets it. A second SIGTERM to a Pi
// that is already exiting changes nothing.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {
  if (!child) {
    cancelled ??= signal;
    process.stdout.write("stopping\n");
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
});
process.stdout.write("ready\n");

function launch() {
  if (cancelled) { record({ code: null, signal: cancelled, started: false }); return; }
  const stdout = openSync(join(runDir, "events.jsonl"), "a");
  const stderr = openSync(join(runDir, "stderr.log"), "a");
  child = spawn(bin, args, { stdio: ["ignore", stdout, stderr] });
  // Pi holds its own copies of the descriptors now.
  closeSync(stdout);
  closeSync(stderr);
  child.on("error", error => record({ code: null, signal: null, error: error.message }));
  child.on("exit", (code, signal) => record({ code, signal }));
}

let input = "", started = false;
process.stdin.on("data", (chunk: Buffer) => {
  if (started) return;
  input += chunk.toString("utf8");
  if (input.includes("start\n")) { started = true; launch(); }
});
const unacknowledged = () => { if (!started) process.exit(3); };
process.stdin.on("end", unacknowledged);
process.stdin.on("error", unacknowledged);
