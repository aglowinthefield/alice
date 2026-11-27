import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Board } from "../server/board.js";
import { Integration } from "../server/integration.js";
import { AutoReview, promptDiff, reviewerPrompt, reviewerVerdict } from "../server/auto-review.js";

function git(repo: string, ...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
const settle = (verdict: string) => [
  JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.5", stopReason: "stop", content: [{ type: "text", text: verdict }],
    usage: { input: 4000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 4050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } } } }),
  JSON.stringify({ type: "agent_settled", aborted: false }), "",
].join("\n");
function fixture(verdict = '{"verdict":"approve","reason":"Diff is small and correct"}') {
  const dir = mkdtempSync(join(tmpdir(), "bakery-auto-review-")), repo = join(dir, "repo"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n"); git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  const piBin = join(dir, "fake-pi");
  // The fake emits the same JSON events as --mode json; it never calls a model.
  writeFileSync(piBin, `#!/bin/sh\ncat <<'EVENTS'\n${settle(verdict)}EVENTS\n`); chmodSync(piBin, 0o755);
  const integration = new Integration(board, data), auto = new AutoReview(board, integration, piBin);
  function reviewedCard() {
    const card = board.createCard({ repo, title: "Add a new line", body: "Include a regression test" });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id), worktree = join(data, "worktrees", card.id);
    git(repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
    board.attach(run.id, process.pid, worktree);
    writeFileSync(join(worktree, "README.md"), `original\nnew ${card.id}\n`);
    board.finish(run.id, "review");
    // The server records this when a run reaches Review; the card's next step depends on it.
    board.recordChangedFiles(run.id, 1);
    return { card: board.getCard(card.id)!, run: board.getRun(run.id)!, worktree };
  }
  return { dir, repo, data, board, repoBoard, auto, reviewedCard, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the agent reviewer's scratch lands in its own TMPDIR, removed when the review ends", async () => {
  const item = fixture();
  try {
    const seen = join(item.dir, "seen");
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nd=$(mktemp -d) && printf '%s' "$d" > "${seen}"\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Look"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    // A run is reviewed only if it finished after auto-review was enabled; backdating avoids a same-millisecond tie.
    item.board.sqlite.prepare("UPDATE boards SET autoReviewEnabledAt='2000-01-01T00:00:00.000Z' WHERE id=?").run(item.repoBoard.id);
    item.reviewedCard();
    await item.auto.tick();
    const scratch = readFileSync(seen, "utf8");
    assert.match(dirname(scratch), /[\\/]bakery-run-[^/\\]+$/);
    assert.equal(existsSync(dirname(scratch)), false);
  } finally { item.close(); }
});

test("a Review card is the agent's turn until its auto-review finishes, then yours", async () => {
  const item = fixture('{"verdict":"needs_human","reason":"No regression test"}');
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const { card } = item.reviewedCard();
    assert.equal(card.reviewWait, "agent_review", "queued for the agent before the tick claims it");
    assert.deepEqual(item.board.cardCounts()[item.repo], { reviewWaiting: 1 });
    await item.auto.tick();
    assert.equal(item.board.getCard(card.id)!.reviewWait, null);
    assert.equal(item.board.getCard(card.id)!.reviewAction, "needs_you", "a hand-off reads as needing you");
    assert.deepEqual(item.board.cardCounts()[item.repo], { review: 1 });
    item.board.setAutoReview(item.repoBoard.id, false);
    const manual = item.reviewedCard().card;
    assert.equal(manual.reviewWait, null, "without auto-review every Review card is yours");
  } finally { item.close(); }
});

test("strict agent verdict rejects missing settlement, invalid JSON, and ambiguous formats", () => {
  assert.deepEqual(reviewerVerdict(settle('{"verdict":"approve","reason":"Looks correct"}')), { verdict: "approve", reason: "Looks correct" });
  assert.throws(() => reviewerVerdict(settle('```json\n{"verdict":"approve","reason":"fine"}\n```')), /not a JSON object: "```json/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine","extra":true}')), /invalid or ambiguous: .*extra/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"aborted":false', '"aborted":true')), /did not settle.*aborted/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"stopReason":"stop"', '"stopReason":"length"')), /did not settle.*stop reason was "length"/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"agent_settled"', '"message_end"')), /did not settle.*never reported agent_settled/);
  // A reviewer that used tools sends earlier assistant messages; only the final one is the verdict.
  const toolCall = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] } });
  assert.deepEqual(reviewerVerdict(`${toolCall}\n${settle('{"verdict":"approve","reason":"Imports checked"}')}`), { verdict: "approve", reason: "Imports checked" });
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"stopReason":"stop"', '"stopReason":"toolUse"')), /did not settle.*stop reason was "toolUse"/);
});

test("on a local board an agent approval is advice: the card waits in Review for Approve, with the verdict and spend recorded", async () => {
  const item = fixture();
  try {
    const old = item.reviewedCard();
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
    item.board.setAutoReview(item.repoBoard.id, true);
    assert.equal(item.board.listAutoReviewCandidates().length, 0, "a card already in Review is not reviewed");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard(), before = git(item.repo, "rev-parse", "main");
    assert.deepEqual(item.board.listAutoReviewCandidates().map(entry => entry.card.id), [current.card.id]);
    await item.auto.tick();
    const job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(job.state, "approved");
    assert.equal(job.details, "Diff is small and correct");
    assert.equal(item.board.getCard(current.card.id)?.reviewAction, "agent_approved", "an approval reads as approved, not as a problem");
    assert.equal(item.board.getCard(current.card.id)?.reviewWait, null, "Approve is still yours");
    assert.equal(git(item.repo, "rev-parse", "main"), before, "nothing merges without a person");
    assert.equal(job.agent, "openai-codex/gpt-5.5");
    assert.equal(item.board.getCard(current.card.id)?.reviewAgent, "openai-codex/gpt-5.5");
    assert.equal(job.cost, 0.03, "agent review spend is recorded");
    assert.equal(job.inputTokens, 4000);
    assert.equal(item.board.getCard(current.card.id)?.cost, 0.03, "card total includes its agent review");
    assert.equal(item.board.getCard(old.card.id)?.status, "review");
    await item.auto.tick();
    assert.equal(item.board.listAutoReviewJobs(current.card.id).length, 1, "the same run is not reviewed twice");
    // Your Approve merges the agent-approved card.
    const integration = new Integration(item.board, item.data);
    assert.equal(integration.approve(item.board.getCard(current.card.id)!, integration.review(item.board.getCard(current.card.id)!).fingerprint).status, "done");
    assert.match(readFileSync(join(item.repo, "README.md"), "utf8"), new RegExp(current.card.id));
  } finally { item.close(); }
});
test("a failed card can be set back to Ready", () => {
  const item = fixture();
  try {
    const { card, worktree } = item.reviewedCard();
    const failed = item.board.claim(card.id);
    item.board.attach(failed.id, process.pid, worktree);
    item.board.finish(failed.id, "failed", "Pi exited (143)");
    assert.equal(item.board.getCard(card.id)?.status, "failed");
    assert.equal(item.board.setStatus(card.id, "ready").status, "ready");
  } finally { item.close(); }
});

test("the global tick reconciles a failed card merged outside Bakery without enabling auto-review", async () => {
  const item = fixture();
  try {
    const { card, run, worktree } = item.reviewedCard();
    const failed = item.board.claim(card.id);
    item.board.attach(failed.id, process.pid, worktree);
    item.board.finish(failed.id, "failed", "Pi exited (143)");
    git(worktree, "add", "README.md");
    git(worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "external card fix");
    const candidate = git(worktree, "rev-parse", "HEAD");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    const mergeCommit = git(item.repo, "rev-parse", "HEAD");
    await item.auto.tick();
    assert.equal(item.board.getCard(card.id)?.status, "done");
    assert.equal(item.board.wasIntegrated(card.id), true);
    const db = new DatabaseSync(join(item.dir, "board.sqlite"));
    try {
      assert.deepEqual({ ...db.prepare("SELECT runId, candidate, mergeCommit FROM external_integrations WHERE cardId=?").get(card.id) as object },
        { runId: failed.id, candidate, mergeCommit });
      assert.equal(db.prepare("SELECT COUNT(*) AS total FROM approvals WHERE cardId=?").get(card.id)!.total, 0);
    } finally { db.close(); }
    assert.equal(item.board.setStatus(card.id, "ready").status, "ready");
    await item.auto.tick();
    assert.equal(item.board.getCard(card.id)?.status, "ready");
    assert.equal(run.status, "review");
  } finally { item.close(); }
});

test("reconciling externally merged cards runs Git without blocking the server, and overlapping calls share one pass", async () => {
  const item = fixture();
  try {
    const { card, worktree } = item.reviewedCard();
    git(worktree, "add", "README.md");
    git(worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "external card fix");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", git(worktree, "rev-parse", "HEAD"));
    const integration = new Integration(item.board, item.data);
    let served = false;
    setImmediate(() => { served = true; });
    const first = integration.reconcileExternallyMerged(), second = integration.reconcileExternallyMerged();
    assert.equal(first, second, "a call while a pass runs joins it");
    await first;
    assert.equal(served, true, "other work ran while Git did");
    assert.equal(item.board.wasIntegrated(card.id), true);
  } finally { item.close(); }
});

test("the global tick ignores ancestry without integration, discarded merges, pending approval, and dirty branches", async () => {
  const item = fixture();
  try {
    const untouched = item.reviewedCard();
    // This branch is an ancestor only because main advanced; it contributed nothing.
    writeFileSync(join(item.repo, "main.txt"), "main only\n");
    git(item.repo, "add", "main.txt");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "new main work");
    await item.auto.tick();
    assert.equal(item.board.getCard(untouched.card.id)?.status, "review");
    const discarded = item.reviewedCard();
    git(discarded.worktree, "add", "README.md");
    git(discarded.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "discarded change");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "-s", "ours", "--no-ff", "--no-edit", git(discarded.worktree, "rev-parse", "HEAD"));
    await item.auto.tick();
    assert.equal(item.board.getCard(discarded.card.id)?.status, "review");
    const pending = item.reviewedCard();
    git(pending.worktree, "add", "README.md");
    git(pending.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "pending change");
    const candidate = git(pending.worktree, "rev-parse", "HEAD");
    item.board.recordApproval(pending.card.id, pending.run.id, candidate);
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    await item.auto.tick();
    assert.equal(item.board.getCard(pending.card.id)?.status, "review");
    const dirty = item.reviewedCard();
    git(dirty.worktree, "add", "README.md");
    git(dirty.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "dirty branch work");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", git(dirty.worktree, "rev-parse", "HEAD"));
    writeFileSync(join(dirty.worktree, "untracked.txt"), "unfinished\n");
    await item.auto.tick();
    assert.equal(item.board.getCard(dirty.card.id)?.status, "review");
    rmSync(join(dirty.worktree, "untracked.txt"));
    await item.auto.tick();
    assert.equal(item.board.getCard(dirty.card.id)?.status, "done");
  } finally { item.close(); }
});

test("a run cannot be claimed while agent review is active, but can start after it finishes", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    item.board.beginAutoReview(current.card.id, current.run.id);
    assert.throws(() => item.board.claim(current.card.id), /Agent review is in progress/);
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(item.board.listRuns(current.card.id).length, 1);
    item.board.finishAutoReview(current.run.id, "needs_human", "Needs human review");
    assert.equal(item.board.claim(current.card.id).attempt, 2);
  } finally { item.close(); }
});

test("card text edits during review leave the candidate for a human", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    const script = join(item.dir, "fake-pi");
    writeFileSync(script, `#!/bin/sh\nnode -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(item.dir, "board.sqlite"))}); db.prepare("UPDATE cards SET body = ? WHERE id = ?").run("Changed acceptance criteria", ${JSON.stringify(current.card.id)}); db.close()'\ncat <<'EVENTS'\n${settle('{"verdict":"approve","reason":"Looks fine"}')}EVENTS\n`);
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /Card changed during agent review/);
  } finally { item.close(); }
});

test("binary changes are never auto-approved without inspectable bytes", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    writeFileSync(join(current.worktree, "image.png"), Buffer.from([0, 1, 2, 3]));
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /Binary.*human review/);
  } finally { item.close(); }
});

test("opening another Board cannot invalidate an active review; explicit restart recovery can", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    item.board.beginAutoReview(current.card.id, current.run.id);
    const second = new Board(join(item.dir, "board.sqlite"));
    assert.equal(second.getAutoReviewJob(current.run.id)?.state, "running");
    second.recoverAutoReviews(); // This method is only called by the exclusive-lock server at startup.
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.state, "needs_human");
    second.close();
  } finally { item.close(); }
});

test("a review interrupted by a restart is queued again once, then left for a person", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    item.board.beginAutoReview(current.card.id, current.run.id);
    item.board.recordAutoReviewUsage(current.run.id, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.5 });
    item.board.recoverAutoReviews();
    let job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(job.requeued, 1);
    assert.match(job.details, /reviewed again/);
    assert.equal(item.board.getCard(current.card.id)!.reviewWait, "agent_review");
    item.board.beginAutoReview(current.card.id, current.run.id);
    job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(job.state, "running");
    assert.equal(job.cost, 0.5, "the interrupted attempt's spend still counts");
    item.board.recoverAutoReviews();
    job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(job.state, "needs_human");
    assert.equal(job.requeued, 0);
    assert.match(job.details, /twice; inspect manually/);
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
    assert.throws(() => item.board.beginAutoReview(current.card.id, current.run.id), /not eligible/);
  } finally { item.close(); }
});

test("draining waits for the review in progress and claims no new ones", async () => {
  const item = fixture();
  try {
    // The fake reviewer takes a moment, so the drain starts while it is still running.
    const fake = join(item.dir, "fake-pi");
    writeFileSync(fake, `#!/bin/sh\nsleep 0.5\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Check manually"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const first = item.reviewedCard(), second = item.reviewedCard();
    const ticking = item.auto.tick();
    while (!item.auto.active) await new Promise(resolve => setTimeout(resolve, 10));
    await item.auto.drain();
    assert.equal(item.auto.active, false);
    assert.equal(item.board.getAutoReviewJob(first.run.id)?.state, "needs_human", "the active review finished instead of being killed");
    await ticking;
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(second.run.id), undefined, "no new review starts while draining");
  } finally { item.close(); }
});

test("disabling auto-review stops new reviews", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const first = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(first.run.id)?.state, "approved");
    item.board.setAutoReview(item.repoBoard.id, false);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoReviewEnabled, false);
    item.reviewedCard();
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
  } finally { item.close(); }
});
test("agent findings or an ambiguous response fail closed", async () => {
  for (const verdict of ['{"verdict":"needs_human","reason":"Missing test"}', 'I approve']) {
    const item = fixture(verdict);
    try {
      item.board.setAutoReview(item.repoBoard.id, true);
      await new Promise(resolve => setTimeout(resolve, 5));
      const current = item.reviewedCard(), before = git(item.repo, "rev-parse", "main");
      await item.auto.tick();
      assert.equal(item.board.getAutoReviewJob(current.run.id)?.state, "needs_human");
      assert.equal(item.board.getCard(current.card.id)?.status, "review");
      assert.equal(git(item.repo, "rev-parse", "main"), before);
    } finally { item.close(); }
  }
});

test("a reviewer that changes the work is left for a person, and restarting does not re-run it", async () => {
  const item = fixture();
  try {
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf changed >> README.md\ncat <<'EVENTS'\n${settle('{"verdict":"approve","reason":"Looks fine"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(current.run.id)!.details, "Work changed during agent review: README.md");
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    const reopened = new Board(join(item.dir, "board.sqlite"));
    assert.equal(reopened.getAutoReviewJob(current.run.id)?.state, "needs_human");
    assert.equal(reopened.listAutoReviewCandidates().length, 0);
    reopened.close();
  } finally { item.close(); }
});
test("a reviewer that adds an untracked file Git does not ignore is left for a person", async () => {
  const item = fixture();
  try {
    writeFileSync(join(item.repo, ".gitignore"), "dist/\n"); git(item.repo, "add", ".gitignore");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "ignore dist");
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf notes > review-notes.md\ncat <<'EVENTS'\n${settle('{"verdict":"approve","reason":"Looks fine"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(current.run.id)!.details, "Work changed during agent review: review-notes.md");
  } finally { item.close(); }
});
test("untracked build output Git ignores leaves the verdict standing, but a rewritten tracked file in it does not", async () => {
  // dist/ is ignored, but the repository commits one generated file in it anyway, as some monorepos do.
  const cases = [
    { build: "mkdir -p dist && printf built > dist/app.js && printf '{}' > tsconfig.tsbuildinfo", details: "Build and tests pass" },
    { build: "printf rebuilt > dist/tokens.js", details: "Work changed during agent review: dist/tokens.js" },
  ];
  for (const { build, details } of cases) {
    const item = fixture();
    try {
      mkdirSync(join(item.repo, "dist"));
      writeFileSync(join(item.repo, ".gitignore"), "dist/\n*.tsbuildinfo\n"); writeFileSync(join(item.repo, "dist", "tokens.js"), "old\n");
      git(item.repo, "add", ".gitignore"); git(item.repo, "add", "-f", "dist/tokens.js");
      git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "ignore build output");
      writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\n${build}\ncat <<'EVENTS'\n${settle('{"verdict":"approve","reason":"Build and tests pass"}')}EVENTS\n`);
      item.board.setAutoReview(item.repoBoard.id, true);
      await new Promise(resolve => setTimeout(resolve, 5));
      const current = item.reviewedCard();
      await item.auto.tick();
      assert.ok(existsSync(join(current.worktree, build.includes("app.js") ? "dist/app.js" : "dist/tokens.js")), "the fake reviewer ran its build");
      assert.equal(item.board.getAutoReviewJob(current.run.id)?.details, details);
    } finally { item.close(); }
  }
});
test("main moving during review is not the work changing: the verdict stands", async () => {
  const item = fixture();
  try {
    // The fake reviewer stands in for another card merging (or an update fast-forwarding main) meanwhile.
    const mainMoves = `printf other > "${item.repo}/other.txt" && git -C "${item.repo}" add other.txt && git -C "${item.repo}" -c user.name=Test -c user.email=test@example.invalid commit -qm "another card"`;
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\n${mainMoves}\ncat <<'EVENTS'\n${settle('{"verdict":"approve","reason":"Diff is small and correct"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.details, "Diff is small and correct");
    assert.equal(readFileSync(join(item.repo, "other.txt"), "utf8"), "other");
  } finally { item.close(); }
});
test("an archived board's cards are not reconciled, so a deleted scratch repository logs nothing", () => {
  const item = fixture();
  try {
    const current = item.reviewedCard();
    assert.deepEqual(item.board.listExternalMergeCandidates().map(entry => entry.card.id), [current.card.id]);
    item.board.archiveBoard(item.repoBoard.id);
    assert.deepEqual(item.board.listExternalMergeCandidates(), []);
  } finally { item.close(); }
});

test("the agent reviewer uses the repository's review model before the prompt", async () => {
  const item = fixture();
  try {
    const argsFile = join(item.dir, "args.txt");
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Check manually"}')}EVENTS\n`);
    item.board.updateSettings({ agentModels: { work: { model: "anthropic/claude-sonnet-4-5", thinking: "" }, conflict: { model: "", thinking: "" }, review: { model: "anthropic/claude-haiku-4-5", thinking: "low" }, draft: { model: "", thinking: "" } } });
    item.board.setAgentModels(item.repoBoard.id, { review: { model: "openai-codex/gpt-5.5" } });
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const { run } = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(run.id)?.state, "needs_human");
    const args = readFileSync(argsFile, "utf8").split("\n");
    const separator = args.indexOf("--");
    assert.deepEqual(args.slice(separator - 4, separator), ["--model", "openai-codex/gpt-5.5", "--thinking", "low"]);
    // The reviewer is fully capable: it keeps tools, extensions, MCP, skills, and context files like card runs do.
    for (const flag of ["--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files"]) assert.ok(!args.includes(flag), flag);
    assert.match(args[separator + 1], /independent reviewer/);
    assert.match(args.slice(separator + 1).join("\n"), /Verification is yours to do/);
  } finally { item.close(); }
});

test("reviewer can request changes with concrete items, and malformed requests are rejected", () => {
  const ask = '{"verdict":"request_changes","reason":"Off by one","changes":[{"path":"src/a.ts","line":12,"comment":"Use < not <="}]}';
  assert.deepEqual(reviewerVerdict(settle(ask)), { verdict: "request_changes", reason: "Off by one", changes: [{ path: "src/a.ts", line: 12, comment: "Use < not <=" }] });
  assert.throws(() => reviewerVerdict(settle('{"verdict":"request_changes","reason":"Off by one"}')), /invalid or ambiguous/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"request_changes","reason":"x","changes":[]}')), /invalid or ambiguous/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"x","changes":[{"path":"a","comment":"b"}]}')), /invalid or ambiguous/);
});

test("reviewer progress reports elapsed time, turns, tool counts and narration without tool arguments", async () => {
  const { ReviewProgress } = await import("../server/auto-review.js");
  const progress = new ReviewProgress(0);
  for (const event of [
    { type: "turn_start" },
    { type: "tool_execution_start", toolName: "read", args: { path: "SECRET" } },
    { type: "tool_execution_start", toolName: "bash" },
    { type: "tool_execution_start", toolName: "read" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking the migration. Now running the tests." }] } },
  ]) progress.feed(JSON.stringify(event));
  progress.feed("not json");
  const text = progress.text(95_000);
  assert.equal(text, "Reviewer agent working · 1m 35s · turn 1 · read ×2, bash ×1\nNow running the tests.");
  progress.feed(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"verdict":"approve","reason":"ok"}' }] } }));
  assert.match(progress.text(95_000), /Now running the tests\.$/);
  assert.doesNotMatch(text, /SECRET/);
});

test("on a pull-request board an agent approval is advice when Bakery cannot push: the card stays in Review with the verdict recorded", async () => {
  const item = fixture();
  try {
    item.board.setRemoteUrl(item.repoBoard.id, "https://github.com/example/repo");
    item.board.setIntegration(item.repoBoard.id, "github-pr");
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    await item.auto.tick();
    const job = item.board.getAutoReviewJob(current.run.id);
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(job?.state, "approved");
    assert.equal(job?.details, "Diff is small and correct");
    assert.equal(item.board.getCard(current.card.id)?.reviewAction, "agent_approved");
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "original\n", "local main is untouched");
  } finally { item.close(); }
});

test("on a pull-request board an agent approval opens the pull request, and the card waits on GitHub", async () => {
  const item = fixture();
  try {
    item.board.setRemoteUrl(item.repoBoard.id, "https://github.com/example/repo");
    item.board.setIntegration(item.repoBoard.id, "github-pr");
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    const opened: { cardId: string; fingerprint: string }[] = [];
    const auto = new AutoReview(item.board, new Integration(item.board, item.data), join(item.dir, "fake-pi"), undefined, async (card, fingerprint) => {
      opened.push({ cardId: card.id, fingerprint });
      item.board.recordPullRequest(card.id, { number: 7, url: "https://github.com/example/repo/pull/7", state: "OPEN" });
      item.board.recordPullRequestPush(card.id, current.run.id);
      return item.board.getCard(card.id)!;
    });
    await auto.tick();
    const job = item.board.getAutoReviewJob(current.run.id), card = item.board.getCard(current.card.id)!;
    assert.deepEqual(opened.map(entry => entry.cardId), [current.card.id]);
    assert.match(opened[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(job?.state, "pull_request");
    assert.equal(job?.details, "Diff is small and correct\n\nOpened https://github.com/example/repo/pull/7");
    assert.equal(card.status, "review");
    assert.equal(card.reviewWait, "github", "the card waits for the pull request to merge, not for a person");
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "original\n", "local main is untouched");
    await auto.tick();
    assert.equal(opened.length, 1, "the same run is not pushed twice");
  } finally { item.close(); }
});

test("on a pull-request board a failed or refused push leaves the agent-approved card for a person", async () => {
  const item = fixture();
  try {
    item.board.setRemoteUrl(item.repoBoard.id, "https://github.com/example/repo");
    item.board.setIntegration(item.repoBoard.id, "github-pr");
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const failing = item.reviewedCard();
    await new AutoReview(item.board, new Integration(item.board, item.data), join(item.dir, "fake-pi"), undefined,
      async () => { throw new Error("GitHub CLI unavailable"); }).tick();
    assert.equal(item.board.getAutoReviewJob(failing.run.id)?.state, "needs_human");
    assert.equal(item.board.getAutoReviewJob(failing.run.id)?.details, "GitHub CLI unavailable");
    assert.equal(item.board.getCard(failing.card.id)?.reviewWait, null);
    const refused = item.reviewedCard();
    // A pre-push hook refusal sends the card back to the implementer and returns it without a pull request.
    await new AutoReview(item.board, new Integration(item.board, item.data), join(item.dir, "fake-pi"), undefined,
      async card => item.board.getCard(card.id)!).tick();
    assert.equal(item.board.getAutoReviewJob(refused.run.id)?.state, "needs_human");
    assert.match(item.board.getAutoReviewJob(refused.run.id)!.details, /^Agent approved, but the push did not reach a pull request/);
  } finally { item.close(); }
});

test("an older auto-review table is rebuilt to accept the pull_request state without losing jobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-auto-review-schema-"));
  try {
    const path = join(dir, "board.sqlite");
    new Board(path).close();
    const db = new DatabaseSync(path);
    try {
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='auto_review_jobs'").get() as { sql: string }).sql;
      db.exec(`DROP TABLE auto_review_jobs; ${sql.replace("'needs_human','approved','merged','pull_request'", "'needs_human','merged'")}`);
      db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,details,startedAt,agent) VALUES ('c','r','merged','kept','2024-01-01','Pi')").run();
      assert.throws(() => db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,startedAt) VALUES ('c','r2','pull_request','2024-01-01')").run(), /CHECK/);
    } finally { db.close(); }
    const board = new Board(path);
    try {
      assert.equal(board.getAutoReviewJob("r")?.details, "kept");
      assert.equal(board.getAutoReviewJob("r")?.agent, "Pi");
    } finally { board.close(); }
    const reopened = new DatabaseSync(path);
    try { reopened.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,startedAt) VALUES ('c','r2','pull_request','2024-01-01')").run(); }
    finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("old agent approvals stored as needs_human read as approved after the migration; real hand-offs stay", () => {
  const item = fixture();
  try {
    const approved = item.reviewedCard(), handedOff = item.reviewedCard(), unpushed = item.reviewedCard();
    const path = join(item.dir, "board.sqlite");
    item.board.close();
    const db = new DatabaseSync(path);
    try {
      // The table as it was before the approved state existed.
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='auto_review_jobs'").get() as { sql: string }).sql;
      db.exec(`DROP TABLE auto_review_jobs; ${sql.replace("'needs_human','approved','merged','pull_request'", "'needs_human','merged','pull_request'")}`);
      const insert = db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,details,startedAt,finishedAt) VALUES (?,?,'needs_human',?,'2024-01-01','2024-01-01')");
      insert.run(approved.card.id, approved.run.id, "Agent approved: Diff is small and correct");
      insert.run(handedOff.card.id, handedOff.run.id, "No regression test");
      insert.run(unpushed.card.id, unpushed.run.id, "Agent approved, but the push did not reach a pull request: fine");
      assert.throws(() => db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,startedAt) VALUES ('c','r2','approved','2024-01-01')").run(), /CHECK/);
    } finally { db.close(); }
    const board = new Board(path);
    try {
      assert.equal(board.getAutoReviewJob(approved.run.id)?.state, "approved");
      assert.equal(board.getAutoReviewJob(approved.run.id)?.details, "Diff is small and correct");
      assert.equal(board.getCard(approved.card.id)?.reviewAction, "agent_approved");
      assert.equal(board.getAutoReviewJob(handedOff.run.id)?.state, "needs_human");
      assert.equal(board.getCard(handedOff.card.id)?.reviewAction, "needs_you");
      assert.equal(board.getAutoReviewJob(unpushed.run.id)?.state, "needs_human", "an approval that still needs a person stays a hand-off");
    } finally { board.close(); }
  } finally { rmSync(item.dir, { recursive: true, force: true }); }
});

test("queued agent reviews show their place, and a board runs as many at once as its concurrency allows", async () => {
  const item = fixture();
  try {
    const fake = join(item.dir, "fake-pi");
    writeFileSync(fake, `#!/bin/sh\nsleep 0.6\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Check manually"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const cards = [item.reviewedCard(), item.reviewedCard(), item.reviewedCard()].map(entry => entry.card.id);
    assert.deepEqual(cards.map(id => item.board.getCard(id)!.reviewQueue), [1, 2, 3].map(position => ({ position, of: 3 })), "first finished is first in line");
    assert.throws(() => item.board.setAutoReviewConcurrency(item.repoBoard.id, 0));
    assert.throws(() => item.board.setAutoReviewConcurrency(item.repoBoard.id, 5));
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoReviewConcurrency, 1, "one at a time by default");
    item.board.setAutoReviewConcurrency(item.repoBoard.id, 2);
    const ticking = item.auto.tick();
    while (item.auto.activeCount < 2) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(item.auto.activeCount, 2, "only two start");
    assert.deepEqual(item.board.getCard(cards[2])!.reviewQueue, { position: 1, of: 1 }, "the third is next in line");
    assert.equal(item.board.getCard(cards[0])!.reviewQueue, null, "a review that started is no longer queued");
    await ticking;
    await item.auto.tick();
    assert.deepEqual(cards.map(id => item.board.listAutoReviewJobs(id).length), [1, 1, 1]);
    assert.equal(item.board.getCard(cards[2])!.reviewWait, null);
  } finally { item.close(); }
});

test("agent reviews take a machine-wide agent slot and wait for one", async () => {
  const item = fixture('{"verdict":"needs_human","reason":"Check manually"}');
  try {
    item.board.updateSettings({ maxActiveAgents: 1 });
    item.board.setAutoReview(item.repoBoard.id, true);
    item.board.setAutoReviewConcurrency(item.repoBoard.id, 2);
    await new Promise(resolve => setTimeout(resolve, 5));
    const first = item.reviewedCard(), second = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.listAutoReviewJobs(first.card.id).length, 1);
    assert.equal(item.board.listAutoReviewJobs(second.card.id).length, 0, "the second review waits for the slot");
    await item.auto.tick();
    assert.equal(item.board.listAutoReviewJobs(second.card.id).length, 1);
  } finally { item.close(); }
});

test("a board's diff limits send big diffs to a person, and 0 turns a limit off", async () => {
  const item = fixture();
  try {
    item.board.setLimitsEnabled(item.repoBoard.id, true);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoReviewMaxFiles, 40);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoReviewMaxPatchChars, 100000);
    assert.throws(() => item.board.setAutoReviewDiffLimits(item.repoBoard.id, { maxFiles: -1 }));
    item.board.setAutoReviewDiffLimits(item.repoBoard.id, { maxPatchChars: 10 });
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const tooBig = item.reviewedCard().card;
    await item.auto.tick();
    assert.match(item.board.listAutoReviewJobs(tooBig.id)[0].details ?? "", /over this board's auto-review limit of 10/);
    item.board.setAutoReviewDiffLimits(item.repoBoard.id, { maxFiles: 0, maxPatchChars: 0 });
    const allowed = item.reviewedCard().card;
    await item.auto.tick();
    assert.doesNotMatch(item.board.listAutoReviewJobs(allowed.id)[0].details ?? "", /limit/);
  } finally { item.close(); }
});

test("the reviewer prompt has it run checks itself and hand person-only evidence to a person", () => {
  const text = reviewerPrompt({ title: "Port the feed", body: "Run verify:pr and attach screenshots" }, "DIFF");
  assert.match(text, /run it and judge the result/);
  assert.match(text, /Never send the work back only because the implementer did not report running it/);
  assert.match(text, /answer needs_human and name the check; do not send it back/);
  assert.match(text, /Card body: Run verify:pr and attach screenshots\n\nDIFF$/);
  assert.doesNotMatch(text, /verification command/);
});

test("the reviewer sees the implementer's report and the card's attachments, so attached screenshots count as evidence", async () => {
  const item = fixture('{"verdict":"needs_human","reason":"Check manually"}');
  try {
    const argsFile = join(item.dir, "args.txt");
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Check manually"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const card = item.board.createCard({ repo: item.repo, title: "Restyle the palette", body: "Attach dark and light screenshots" });
    item.board.setStatus(card.id, "ready");
    const run = item.board.claim(card.id), worktree = join(item.data, "worktrees", card.id);
    git(item.repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
    item.board.attach(run.id, process.pid, worktree);
    writeFileSync(join(worktree, "README.md"), "restyled\n");
    item.board.recordReport(run.id, "Restyled the palette. Screenshots attached for both themes.");
    item.board.addAttachment({ id: "shot", cardId: card.id, name: "palette-dark.png", type: "image/png", size: 10 });
    item.board.finish(run.id, "review");
    await item.auto.tick();
    const prompt = readFileSync(argsFile, "utf8");
    assert.match(prompt, /implementer's report for this run[^\n]*\nRestyled the palette\. Screenshots attached for both themes\./);
    assert.match(prompt, new RegExp(`- ${item.data}/attachments/${card.id}/[^ ]*palette-dark\\.png \\(palette-dark\\.png, image/png\\)`));
    assert.match(prompt, /a screenshot that shows what the card asks for is evidence/);
  } finally { item.close(); }
});

test("the reviewer prompt names the changed files and tells it to run git diff against the base, not carry the patch", () => {
  const text = promptDiff(["a.ts", "b.ts"], "abc123");
  assert.match(text, /git diff abc123/);
  assert.match(text, /Changed files \(2\):\na\.ts\nb\.ts/);
  const many = promptDiff(Array.from({ length: 250 }, (_, i) => `f${i}`), "abc123");
  assert.match(many, /and 50 more/);
  assert.doesNotMatch(many, /f200/);
});

test("auto-review is not stopped by the diff viewer's 200-file cap, but still refuses binary files and symlinks", async () => {
  const item = fixture('{"verdict":"needs_human","reason":"Stop here"}');
  try {
    item.board.setAutoReview(item.repoBoard.id, true);
    item.board.setAutoReviewDiffLimits(item.repoBoard.id, { maxFiles: 0, maxPatchChars: 0 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const many = item.reviewedCard();
    for (let i = 0; i < 250; i++) writeFileSync(join(many.worktree, `f${i}.txt`), "x\n");
    const binary = item.reviewedCard();
    writeFileSync(join(binary.worktree, "image.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
    await item.auto.tick();
    await item.auto.tick();
    assert.equal(item.board.listAutoReviewJobs(many.card.id)[0].details, "Agent requested human review: Stop here", "reached the reviewer");
    assert.match(item.board.listAutoReviewJobs(binary.card.id)[0].details, /Binary, symlink, or submodule/);
  } finally { item.close(); }
});
