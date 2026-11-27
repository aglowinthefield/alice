import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { commitIdentityArgs } from "../server/git-identity.js";
import { Integration } from "../server/integration.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

test("Alice's approval commits and merge are the operator's: their identity, signed with their key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-identity-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), key = join(dir, "signing");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "operator", "-f", key]);
  writeFileSync(join(dir, "allowed_signers"), `operator@example.invalid ${execFileSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" }).trim()}\n`);
  git(repo, "init", "-q", "-b", "main");
  for (const [name, value] of [["user.name", "Operator"], ["user.email", "operator@example.invalid"], ["gpg.format", "ssh"], ["user.signingkey", `${key}.pub`], ["commit.gpgsign", "true"], ["gpg.ssh.allowedSignersFile", join(dir, "allowed_signers")]])
    git(repo, "config", name, value);
  writeFileSync(join(repo, "README.md"), "original\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  const board = new Board(join(dir, "board.sqlite"));
  try {
    const created = board.createCard({ title: "Operator work", body: "", repo });
    board.setStatus(created.id, "ready");
    const run = board.claim(created.id), worktree = join(data, "worktrees", created.id);
    git(repo, "worktree", "add", "-qb", `alice/${created.id}`, worktree, "HEAD");
    board.attach(run.id, process.pid, worktree);
    board.finish(run.id, "review");
    writeFileSync(join(worktree, "README.md"), "original\nreviewed\n");
    const card = board.getCard(created.id)!, integration = new Integration(board, data);
    assert.equal((await integration.approve(card, (await integration.review(card)).fingerprint)).status, "done");
    const format = "--format=%an <%ae>|%cn <%ce>|%G?|%GS|%s";
    assert.deepEqual([git(repo, "log", "-1", format, "main"), git(repo, "log", "-1", format, "main^2")], [
      "Operator <operator@example.invalid>|Operator <operator@example.invalid>|G|operator@example.invalid|Merge card: Operator work",
      "Operator <operator@example.invalid>|Operator <operator@example.invalid>|G|operator@example.invalid|Alice card: Operator work",
    ]);
  } finally { board.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Alice fills in its own name and email only where the repository has none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-identity-"));
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  try {
    writeFileSync(join(dir, "empty-gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = join(dir, "empty-gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    git(dir, "init", "-q");
    assert.deepEqual(await commitIdentityArgs(dir), ["-c", "user.name=Alice", "-c", "user.email=alice@localhost"]);
    git(dir, "config", "user.email", "operator@example.invalid");
    assert.deepEqual(await commitIdentityArgs(dir), ["-c", "user.name=Alice"]);
    git(dir, "config", "user.name", "Operator");
    assert.deepEqual(await commitIdentityArgs(dir), []);
  } finally {
    for (const [name, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
