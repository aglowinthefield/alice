import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardBranch } from "../server/legacy-names.js";

test("a card works on alice/<id>, or on the bakery/<id> branch its open PR already has", () => {
  const repo = mkdtempSync(join(tmpdir(), "alice-branch-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    assert.equal(cardBranch(repo, "new"), "alice/new");
    git("branch", "bakery/old");
    assert.equal(cardBranch(repo, "old"), "bakery/old");
    git("branch", "alice/old");
    assert.equal(cardBranch(repo, "old"), "alice/old", "the new name wins when both exist");
    git("update-ref", "refs/remotes/origin/bakery/pushed", "HEAD");
    assert.equal(cardBranch(repo, "pushed"), "bakery/pushed", "a PR branch only on origin counts too");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
