import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOrigin, run, Serial } from "../server/git-async.js";
import { fetchOriginBestEffort } from "../server/origin.js";
import { fakeGit, waitFor, withPath } from "./fake-git.js";

const posix = process.platform === "win32" && "uses POSIX shell scripts";

// The timeout only bounds a failure: without EOF on stdin, `cat` never exits.
test("a command that reads stdin sees EOF, as with the synchronous calls it replaced", { skip: posix, timeout: 20_000 }, async () => {
  assert.deepEqual(await run("sh", ["-c", "cat; echo done"]), { stdout: "done\n", stderr: "" });
});

test("overlapping fetches of one repository share a Git process, and each caller keeps its own error policy", { skip: posix, timeout: 60_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bakery-git-async-")));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", join(dir, "missing.git")]);
  const fake = fakeGit(dir, [{ name: "fetch", match: `${repo} fetch origin` }]);
  try {
    await withPath(fake.bin, async () => {
      const strict = fetchOrigin(repo, 120_000), again = fetchOrigin(repo, 120_000);
      await waitFor(() => fake.waiting("fetch"), "the fetch to be held");
      fake.release("fetch");
      // The remote does not exist, so the shared fetch fails for both callers.
      await assert.rejects(strict);
      await assert.rejects(again);
      assert.equal(fake.count("fetch"), 1, "one Git process for both");
      // The best-effort caller turns the same failure into a warning.
      assert.match(await fetchOriginBestEffort(repo, 120_000) ?? "", /git fetch origin failed/);
    });
  } finally { fake.releaseAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("Serial runs one key's work in order and idle waits for all of it", async () => {
  const serial = new Serial(), order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const first = serial.run("repo", async () => { await gate; order.push("first"); });
  const second = serial.run("repo", async () => { order.push("second"); throw new Error("refused"); });
  const third = serial.run("repo", async () => { order.push("third"); });
  let idle = false;
  const waiting = serial.idle().then(() => { idle = true; });
  await Promise.resolve();
  assert.deepEqual(order, [], "nothing runs past the held first job");
  open();
  await first; await assert.rejects(second, /refused/); await third; await waiting;
  assert.deepEqual(order, ["first", "second", "third"], "a failure does not stop the queue");
  assert.equal(idle, true);
});
