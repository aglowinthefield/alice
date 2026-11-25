import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Card } from "../server/board.js";
import { Integration } from "../server/integration.js";

const commitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm"];
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
/** `git status --porcelain` lines, untrimmed so " M" (unstaged) and "M " (staged) stay apart. */
const status = (worktree: string) => execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();

/** A local board with a parent card and a card that depends on it, both in Review on worktrees cut from main. */
function fixture({ autoReview = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-dependents-"));
  const repo = join(dir, "repo"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n");
  writeFileSync(join(repo, "notes.txt"), "notes\n");
  git(repo, "add", ".");
  git(repo, ...commitArgs, "initial");
  const board = new Board(join(dir, "board.sqlite"));
  const repoBoard = board.addRepo(repo);
  if (autoReview) board.setAutoReview(repoBoard.id, true);
  const reviewed = (title: string) => {
    const card = board.createCard({ title, body: "", repo });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id), worktree = join(data, "worktrees", card.id);
    git(repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
    board.attach(run.id, process.pid, worktree);
    return { card, run, worktree, finish: () => board.finish(run.id, "review") };
  };
  const parent = reviewed("Parent"), child = reviewed("Child");
  board.addDependency(child.card.id, parent.card.id);
  const integration = new Integration(board, data);
  return { dir, repo, board, integration, parent, child,
    approve: (card: Card) => integration.approve(card, integration.review(card).fingerprint),
    note: (cardId: string) => board.listCardEvents(cardId).map(event => event.reason).filter(Boolean).at(-1) ?? "",
    close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a Review card is brought up to date with main when the card it depends on merges, keeping its work uncommitted", async () => {
  const f = fixture({ autoReview: true });
  try {
    writeFileSync(join(f.parent.worktree, "README.md"), "original\nfrom parent\n");
    f.parent.finish();
    writeFileSync(join(f.child.worktree, "notes.txt"), "notes\nfrom child\n");
    writeFileSync(join(f.child.worktree, "child.txt"), "new child file\n");
    f.child.finish();
    // The child was already reviewed by the agent; a new base makes that verdict stale.
    f.board.beginAutoReview(f.child.card.id, f.child.run.id);
    f.board.finishAutoReview(f.child.run.id, "needs_human", "Agent approved: looks right");
    assert.equal(f.board.getCard(f.child.card.id)!.reviewWait, null);
    const childHead = git(f.child.worktree, "rev-parse", "HEAD");

    assert.equal(f.approve(f.board.getCard(f.parent.card.id)!).status, "done");
    await f.integration.dependentUpdatesSettled();

    const main = git(f.repo, "rev-parse", "main");
    assert.notEqual(main, childHead);
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), main, "the child's branch fast-forwarded to the new main");
    assert.equal(readFileSync(join(f.child.worktree, "README.md"), "utf8"), "original\nfrom parent\n", "the parent's work is in the child worktree");
    assert.equal(readFileSync(join(f.child.worktree, "notes.txt"), "utf8"), "notes\nfrom child\n");
    assert.equal(readFileSync(join(f.child.worktree, "child.txt"), "utf8"), "new child file\n");
    assert.deepEqual(status(f.child.worktree), [" M notes.txt", "?? child.txt"], "the child's work is still uncommitted and unstaged");
    const child = f.board.getCard(f.child.card.id)!;
    assert.equal(child.status, "review");
    assert.equal(child.reviewWait, "agent_review", "agent review is queued again on the updated work");
    assert.deepEqual(f.board.listMergeFailures(f.repo), []);
    assert.match(f.note(child.id), /Brought up to date with main \([0-9a-f]{12}\) after "Parent" merged\. Agent review runs again/);
    assert.deepEqual(f.integration.review(child).files.map(file => file.path).sort(), ["child.txt", "notes.txt"], "the review diff shows only the child's own work");

    // The updated child still approves and lands on top of the parent.
    f.board.setAutoReview(f.board.boardForRepo(f.repo)!.id, false);
    assert.equal(f.approve(f.board.getCard(child.id)!).status, "done");
    await f.integration.dependentUpdatesSettled();
    assert.equal(readFileSync(join(f.repo, "notes.txt"), "utf8"), "notes\nfrom child\n");
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "original\nfrom parent\n");
  } finally { f.close(); }
});

test("a dependent branch with commits of its own gets main merged in with a merge commit", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.parent.worktree, "README.md"), "original\nfrom parent\n");
    f.parent.finish();
    writeFileSync(join(f.child.worktree, "committed.txt"), "committed\n");
    git(f.child.worktree, "add", "committed.txt");
    git(f.child.worktree, ...commitArgs, "child commit");
    writeFileSync(join(f.child.worktree, "notes.txt"), "notes\nuncommitted\n");
    f.child.finish();
    const childHead = git(f.child.worktree, "rev-parse", "HEAD");

    f.approve(f.board.getCard(f.parent.card.id)!);
    const [result] = await f.integration.updateDependents(f.parent.card.id);
    assert.equal(result.outcome, "current", "Approve already updated the child, so a second pass has nothing to do");

    const main = git(f.repo, "rev-parse", "main");
    assert.equal(git(f.child.worktree, "rev-list", "--parents", "-n", "1", "HEAD"), `${git(f.child.worktree, "rev-parse", "HEAD")} ${childHead} ${main}`);
    assert.equal(git(f.child.worktree, "log", "-1", "--format=%s"), `Merge main into bakery/${f.child.card.id}`);
    assert.equal(readFileSync(join(f.child.worktree, "README.md"), "utf8"), "original\nfrom parent\n");
    assert.deepEqual(status(f.child.worktree), [" M notes.txt"]);
    assert.match(f.note(f.child.card.id), /with a merge commit on the card branch\. Refresh the diff/);
  } finally { f.close(); }
});

test("a dependent that would conflict with the new main shows the conflict and is left unchanged", async () => {
  const f = fixture({ autoReview: true });
  try {
    writeFileSync(join(f.parent.worktree, "README.md"), "from parent\n");
    f.parent.finish();
    writeFileSync(join(f.child.worktree, "README.md"), "from child\n");
    writeFileSync(join(f.child.worktree, "child.txt"), "new child file\n");
    f.child.finish();
    f.board.beginAutoReview(f.child.card.id, f.child.run.id);
    f.board.finishAutoReview(f.child.run.id, "needs_human", "Agent approved: looks right");
    const childHead = git(f.child.worktree, "rev-parse", "HEAD"), before = status(f.child.worktree);

    f.approve(f.board.getCard(f.parent.card.id)!);
    await f.integration.dependentUpdatesSettled();

    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), childHead, "the branch did not move");
    assert.deepEqual(status(f.child.worktree), before, "the worktree is exactly as it was");
    assert.equal(readFileSync(join(f.child.worktree, "README.md"), "utf8"), "from child\n");
    const [failure] = f.board.listMergeFailures(f.repo);
    assert.deepEqual({ cardId: failure?.cardId, files: failure?.files }, { cardId: f.child.card.id, files: ["README.md"] });
    assert.match(failure.details, /up to date with main .* after "Parent" merged conflicts in README\.md\. Bakery changed nothing/);
    const child = f.board.getCard(f.child.card.id)!;
    assert.equal(child.status, "review");
    assert.equal(child.reviewWait, null, "a conflicting card is not queued for agent review");
    assert.match(f.note(child.id), /Choose Fix conflict with Pi/);
  } finally { f.close(); }
});

test("a dependent with an approval in progress is left alone", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.parent.worktree, "README.md"), "original\nfrom parent\n");
    f.parent.finish();
    f.child.finish();
    f.approve(f.board.getCard(f.parent.card.id)!);
    await f.integration.dependentUpdatesSettled();
    const childHead = git(f.child.worktree, "rev-parse", "HEAD");
    // Main moves again, and a pending approval holds the child: Bakery must not move its branch under it.
    writeFileSync(join(f.repo, "other.txt"), "other\n"); git(f.repo, "add", "other.txt"); git(f.repo, ...commitArgs, "other");
    writeFileSync(join(f.child.worktree, "child.txt"), "child\n");
    f.board.recordApproval(f.child.card.id, f.child.run.id, childHead);
    const [result] = await f.integration.updateDependents(f.parent.card.id);
    assert.equal(result.outcome, "skipped");
    assert.match(result.detail, /an approval is in progress/);
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), childHead);
  } finally { f.close(); }
});
