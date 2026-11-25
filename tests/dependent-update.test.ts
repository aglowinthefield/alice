import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Card } from "../server/board.js";
import { Integration } from "../server/integration.js";
import { AutoReview } from "../server/auto-review.js";

const commitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm"];
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
/** `git status --porcelain` lines, untrimmed so " M" (unstaged) and "M " (staged) stay apart. */
const status = (worktree: string) => execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

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
    f.board.finishAutoReview(f.child.run.id, "approved", "Looks right");
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
    f.board.finishAutoReview(f.child.run.id, "approved", "Looks right");
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

test("an ignored local file that main starts tracking is reported as a conflict and nothing changes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.parent.worktree, "secret.env"), "from main\n");
    f.parent.finish();
    // The child ignores secret.env and has its own copy, which the update must not overwrite.
    writeFileSync(join(f.child.worktree, ".gitignore"), "secret.env\n");
    writeFileSync(join(f.child.worktree, "secret.env"), "local secret\n");
    writeFileSync(join(f.child.worktree, "notes.txt"), "notes\nfrom child\n");
    f.child.finish();
    const childHead = git(f.child.worktree, "rev-parse", "HEAD"), before = status(f.child.worktree), index = git(f.child.worktree, "ls-files", "-s");

    f.approve(f.board.getCard(f.parent.card.id)!);
    await f.integration.dependentUpdatesSettled();

    assert.equal(readFileSync(join(f.child.worktree, "secret.env"), "utf8"), "local secret\n");
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), childHead);
    assert.equal(git(f.child.worktree, "ls-files", "-s"), index, "the index is unchanged");
    assert.deepEqual(status(f.child.worktree), before);
    const [failure] = f.board.listMergeFailures(f.repo);
    assert.deepEqual(failure?.files, ["secret.env"]);
    assert.match(failure.details, /would overwrite local files Git ignores: secret\.env\. Bakery changed nothing/);
  } finally { f.close(); }
});

test("staged changes stay staged apart from unstaged ones, even a staged file deleted from the worktree", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.parent.worktree, "README.md"), "original\nfrom parent\n");
    f.parent.finish();
    writeFileSync(join(f.child.worktree, "notes.txt"), "notes\nstaged\n");
    git(f.child.worktree, "add", "notes.txt");
    rmSync(join(f.child.worktree, "notes.txt"));
    writeFileSync(join(f.child.worktree, "child.txt"), "unstaged\n");
    f.child.finish();

    f.approve(f.board.getCard(f.parent.card.id)!);
    await f.integration.dependentUpdatesSettled();

    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "main"));
    assert.equal(readFileSync(join(f.child.worktree, "README.md"), "utf8"), "original\nfrom parent\n");
    assert.equal(git(f.child.worktree, "show", ":notes.txt"), "notes\nstaged", "the staged content is still staged");
    assert.equal(existsSync(join(f.child.worktree, "notes.txt")), false, "and still deleted from the worktree");
    assert.deepEqual(status(f.child.worktree), ["?? child.txt", "MD notes.txt"]);
    assert.deepEqual(f.board.listMergeFailures(f.repo), []);
  } finally { f.close(); }
});

test("a dependent with an approval in progress waits, and is updated once the approval is withdrawn", async () => {
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
    assert.equal(result.outcome, "deferred");
    assert.match(result.detail, /an approval is in progress\. Bakery updates it once that finishes/);
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), childHead);
    assert.deepEqual(await f.integration.retryDeferredDependents(), [{ cardId: f.child.card.id, outcome: "deferred", detail: "" }], "still busy, and noted only once");

    f.board.cancelApproval(f.child.card.id, f.child.run.id);
    const [retried] = await f.integration.retryDeferredDependents();
    assert.equal(retried.outcome, "updated");
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "main"));
    assert.equal(readFileSync(join(f.child.worktree, "other.txt"), "utf8"), "other\n");
    assert.deepEqual(f.board.listDeferredDependentUpdates(), []);
  } finally { f.close(); }
});

test("a parent that merges during the dependent's agent review updates it after that review, and it is reviewed again", async () => {
  const f = fixture();
  const log = join(f.dir, "reviews.log"), release = join(f.dir, "release"), piBin = join(f.dir, "fake-pi");
  const settled = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: '{"verdict":"approve","reason":"Looks right"}' }] } }),
    JSON.stringify({ type: "agent_settled", aborted: false }),
  ].join("\n");
  // The fake reviewer records whether the parent's work is in the tree it reviews, then waits to be released.
  writeFileSync(piBin, `#!/bin/sh\nif [ -f parent.txt ]; then echo with-parent >> '${log}'; else echo without-parent >> '${log}'; fi\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\ncat <<'EVENTS'\n${settled}\nEVENTS\n`);
  chmodSync(piBin, 0o755);
  const reviews = () => readFileSync(log, "utf8").trim().split("\n");
  try {
    writeFileSync(join(f.parent.worktree, "parent.txt"), "from parent\n");
    f.parent.finish();
    // Only the child finishes after auto-review is turned on, so only the child is reviewed.
    const enabledAt = f.board.setAutoReview(f.board.boardForRepo(f.repo)!.id, true).autoReviewEnabledAt!;
    while (new Date().toISOString() <= enabledAt) { /* The child's run must finish after auto-review was enabled. */ }
    writeFileSync(join(f.child.worktree, "child.txt"), "child\n");
    f.child.finish();
    const auto = new AutoReview(f.board, f.integration, piBin);
    const first = auto.tick();
    await waitFor(() => existsSync(log));
    assert.equal(f.board.getAutoReviewJob(f.child.run.id)?.state, "running");

    const childHead = git(f.child.worktree, "rev-parse", "HEAD");
    f.approve(f.board.getCard(f.parent.card.id)!);
    await f.integration.dependentUpdatesSettled();
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), childHead, "the worktree under review is left alone");
    assert.match(f.note(f.child.card.id), /an agent review is in progress\. Bakery updates it once that finishes/);

    writeFileSync(release, "");
    await first;
    assert.equal(f.board.getAutoReviewJob(f.child.run.id)?.state, "approved");
    await auto.tick();
    assert.equal(git(f.child.worktree, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "main"), "the child received current main");
    assert.equal(readFileSync(join(f.child.worktree, "child.txt"), "utf8"), "child\n");
    assert.deepEqual(reviews(), ["without-parent", "with-parent"], "the child was reviewed again, on the updated tree");
    assert.equal(f.board.getAutoReviewJob(f.child.run.id)?.state, "approved");
    assert.deepEqual(f.board.listDeferredDependentUpdates(), []);
  } finally { f.close(); }
});
