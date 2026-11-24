import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { writeTopic } from "../server/chat.js";
import { discuss } from "../server/discuss.js";
import { draftPullRequest } from "../server/pr-draft.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const realSetTimeout = setTimeout;
const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await new Promise(resolve => realSetTimeout(resolve, 100)); };

/** A Pi stand-in that starts a long-lived descendant, records its pid, prints `flood` characters, then hangs. */
function hangingPi(dir: string, flood: number) {
  const path = join(dir, "pi-hang");
  writeFileSync(path, `#!/usr/bin/env node
const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
require("fs").writeFileSync(${JSON.stringify(join(dir, "descendant.pid"))}, String(c.pid));
process.stdout.write("x".repeat(${flood}) + "\\n");
setInterval(() => {}, 1000);
`);
  chmodSync(path, 0o755);
  return { path, descendant: () => Number(readFileSync(join(dir, "descendant.pid"), "utf8")) };
}

/** On Windows `child.kill()` leaves the descendant running, so it must be gone; elsewhere it is left to the caller to clean up. */
async function checkDescendant(pi: ReturnType<typeof hangingPi>) {
  const pid = pi.descendant();
  try {
    if (process.platform === "win32") {
      await until(() => !alive(pid));
      assert.equal(alive(pid), false, "descendant is gone");
    }
  } finally { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
}

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-kill-"));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("a chat topic that exceeds its output limit stops Pi and what Pi started", () => withDir(async dir => {
  const pi = hangingPi(dir, 250_000);
  await assert.rejects(writeTopic(pi.path, dir, [], "hello"), /Pi failed|topic/);
  await checkDescendant(pi);
}));

test("a pull request draft that exceeds its output limit stops Pi and what Pi started", () => withDir(async dir => {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Summary\n");
  const pi = hangingPi(dir, 1_100_000);
  const draft = await draftPullRequest({ card: { id: "c", title: "t", body: "" } as never, run: { output: "" } as never, worktree: dir, patch: "", piBin: pi.path, models: [] });
  assert.match(draft.problem, /output limit/);
  await checkDescendant(pi);
}));

test("a discussion that runs past ten minutes stops Pi and what Pi started", () => withDir(async dir => {
  const pi = hangingPi(dir, 10);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const result = discuss({ prompt: "hi", cwd: dir, piBin: pi.path, models: [] });
    const settled = result.then(() => undefined, error => error as Error);
    // The fake records its descendant before the timer fires; real time passes while waiting for the file.
    await until(() => existsSync(join(dir, "descendant.pid")) && readFileSync(join(dir, "descendant.pid"), "utf8") !== "");
    mock.timers.tick(10 * 60_000);
    assert.match((await settled)!.message, /timed out or exceeded/);
  } finally { mock.timers.reset(); }
  await checkDescendant(pi);
}));
