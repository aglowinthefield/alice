import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Card } from "../server/board.js";
import { loopGuards } from "../server/repo-limits.js";
import { Worker } from "../server/worker.js";
import { AutoPullRequest } from "../server/auto-pull-request.js";
import { runningWork } from "../server/running.js";

function git(repo: string, ...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function fixture(mode: "github-pr" | "local" = "github-pr") {
  const dir = mkdtempSync(join(tmpdir(), "alice-auto-pr-")), repo = join(dir, "repo"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n"); git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  if (mode === "github-pr") { board.setRemoteUrl(repoBoard.id, "https://github.com/example/repo"); board.setIntegration(repoBoard.id, "github-pr"); }
  const opened: string[] = [];
  const open = async (card: Card) => {
    opened.push(card.id);
    board.recordPullRequest(card.id, { number: 7, url: "https://github.com/example/repo/pull/7", state: "OPEN" });
    board.recordPullRequestPush(card.id, board.listRuns(card.id)[0].id);
    return board.getCard(card.id)!;
  };
  function reviewedCard() {
    const card = board.createCard({ repo, title: "Add a line", body: "b" });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id);
    board.attach(run.id, process.pid, join(data, "worktrees", card.id));
    board.finish(run.id, "review");
    return board.getCard(card.id)!;
  }
  const draft = async () => ({ title: "t", body: "b" });
  const auto = new AutoPullRequest(board, () => "f".repeat(64), draft, open);
  return { board, repoBoard, auto, draft, opened, reviewedCard, open, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const later = () => new Promise(resolve => setTimeout(resolve, 5));

test("automatic pull requests are off by default and open only runs that finish after they are turned on", async () => {
  const item = fixture();
  try {
    assert.equal(item.repoBoard.autoPullRequestEnabled, false);
    const waiting = item.reviewedCard();
    await item.auto.tick();
    assert.deepEqual(item.opened, [], "off: nothing is opened");
    await later();
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    await item.auto.tick();
    assert.deepEqual(item.opened, [], "the backlog from before the opt-in stays for Approve");
    await later();
    const fresh = item.reviewedCard();
    await item.auto.tick();
    assert.deepEqual(item.opened, [fresh.id]);
    assert.notEqual(waiting.id, fresh.id);
    await item.auto.tick();
    assert.deepEqual(item.opened, [fresh.id], "the same run is not pushed twice");
  } finally { item.close(); }
});

test("a failed automatic push is recorded for a person and not retried for the same run", async () => {
  const item = fixture();
  try {
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    await later();
    const card = item.reviewedCard();
    const failing = new AutoPullRequest(item.board, () => "f".repeat(64), item.draft, async () => { throw new Error("GitHub CLI unavailable"); });
    await failing.tick();
    assert.match(item.board.getCard(card.id)!.prError!, /could not open the pull request automatically: GitHub CLI unavailable/);
    assert.ok(item.board.listCardEvents(card.id).some(event => /GitHub CLI unavailable/.test(event.reason)));
    await item.auto.tick();
    assert.deepEqual(item.opened, []);
  } finally { item.close(); }
});

test("a card waiting for or having its pull request opened automatically is not waiting for you; a failed open is", async () => {
  const { runningView } = await import(new URL("../scripts/cli-board.mjs", import.meta.url).href);
  const item = fixture();
  try {
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    await later();
    const card = item.reviewedCard();
    let release!: () => void;
    const pushing = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const reachedPush = new Promise<void>(resolve => { reached = resolve; });
    const auto = new AutoPullRequest(item.board, () => "f".repeat(64), item.draft, async () => { reached(); await pushing; throw new Error("GitHub CLI unavailable"); });
    const work = () => runningWork(item.board, { runs: [], reviews: [], drafts: [], opening: auto.inProgress });
    const view = () => runningView(work(), item.board.listCards(), item.board.listBoards());
    assert.deepEqual(work().map(entry => [entry.kind, entry.cardId, entry.queued]), [["pr", card.id, true]], "queued for the scheduler");
    assert.deepEqual([view().waiting, view().queued.prs], [[], 1]);
    const ticking = auto.tick();
    await reachedPush;
    assert.deepEqual(work().map(entry => [entry.kind, entry.queued, entry.tool]), [["pr", false, "pushing"]]);
    assert.deepEqual([view().waiting, view().active.length], [[], 1]);
    assert.equal(runningWork(item.board, { runs: [], reviews: [], drafts: [{ cardId: card.id, since: 1, step: "Model is thinking" }], opening: auto.inProgress })
      .map(entry => `${entry.kind}:${entry.tool}`).join(), "pr:Model is thinking", "one row per card, showing its draft's step");
    release();
    await ticking;
    assert.deepEqual(work(), [], "a failed open is not retried for this run");
    assert.deepEqual(view().waiting.map((entry: { id: string }) => entry.id), [card.id], "so the card asks for you again");
  } finally { item.close(); }
});

test("a card that keeps coming back from a refused push is only tried a few times", async () => {
  const item = fixture();
  try {
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    await later();
    const card = item.reviewedCard();
    let pushes = 0;
    // A pre-push hook refusal returns the card without a pull request and starts a fix run that reaches Review again.
    const refused = new AutoPullRequest(item.board, () => "f".repeat(64), item.draft, async current => {
      pushes++;
      item.board.setStatus(current.id, "ready");
      const run = item.board.claim(current.id);
      item.board.attach(run.id, process.pid, "/tmp/none");
      item.board.finish(run.id, "review");
      return item.board.getCard(current.id)!;
    });
    for (let round = 0; round < loopGuards.autoPullRequestPushes + 2; round++) await refused.tick();
    assert.equal(pushes, loopGuards.autoPullRequestPushes);
    assert.equal(item.board.getCard(card.id)!.status, "review", "then the card waits for Approve");
  } finally { item.close(); }
});

test("with auto-review on, a pull request opens as a draft only after the agent reviewer hands the card to a person", async () => {
  const item = fixture();
  try {
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    item.board.setAutoReview(item.repoBoard.id, true);
    await later();
    const card = item.reviewedCard(), run = item.board.listRuns(card.id)[0];
    assert.equal(item.board.listAutoPullRequestCandidates().length, 0, "the reviewer has not looked yet");
    item.board.beginAutoReview(card.id, run.id);
    assert.equal(item.board.listAutoPullRequestCandidates().length, 0, "still reviewing");
    item.board.finishAutoReview(run.id, "needs_human", "Agent requested human review: risky", "f".repeat(64), undefined, "The agent reviewer left this for a person:\n\nrisky");
    assert.deepEqual(item.board.listAutoPullRequestCandidates().map(entry => entry.card.id), [card.id]);
    let handoff: string | undefined;
    const auto = new AutoPullRequest(item.board, () => "f".repeat(64), item.draft, async (current, _fingerprint, _draft, findings) => { handoff = findings; return item.open(current); });
    await auto.tick();
    assert.match(handoff ?? "", /risky/);
    assert.deepEqual(item.opened, [card.id]);
  } finally { item.close(); }
});

test("with auto-review on, a card the reviewer sent back or approved is not opened by automatic pull requests", async () => {
  const item = fixture();
  try {
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    item.board.setAutoReview(item.repoBoard.id, true);
    await later();
    const sent = item.reviewedCard(), sentRun = item.board.listRuns(sent.id)[0];
    item.board.beginAutoReview(sent.id, sentRun.id);
    item.board.finishAutoReview(sentRun.id, "needs_human", "Sent back", "f".repeat(64), [{ path: "a", comment: "fix" }]);
    const approved = item.reviewedCard(), approvedRun = item.board.listRuns(approved.id)[0];
    item.board.beginAutoReview(approved.id, approvedRun.id);
    item.board.finishAutoReview(approvedRun.id, "pull_request", "ok", "f".repeat(64));
    assert.equal(item.board.listAutoPullRequestCandidates().length, 0);
  } finally { item.close(); }
  const local = fixture("local");
  try {
    local.board.setAutoPullRequest(local.repoBoard.id, true);
    await later();
    local.reviewedCard();
    assert.equal(local.board.listAutoPullRequestCandidates().length, 0, "a local board never opens pull requests");
  } finally { local.close(); }
});

test("nothing is pushed when, while the draft is written, auto-review is turned off or an external pull request is linked", async () => {
  for (const change of ["override", "opt-out"] as const) {
    const item = fixture();
    try {
      item.board.setAutoPullRequest(item.repoBoard.id, true);
      await later();
      const card = item.reviewedCard();
      let pushed = 0;
      const auto = new AutoPullRequest(item.board, () => "f".repeat(64), async () => {
        if (change === "override") item.board.setPullRequestOverride(card.id, "https://github.com/example/repo/pull/99");
        else item.board.setAutoPullRequest(item.repoBoard.id, false);
        return { title: "t", body: "b" };
      }, async current => { pushed++; return current; });
      await auto.tick();
      assert.equal(pushed, 0, change);
      assert.match(item.board.getCard(card.id)!.prError ?? "", /could not open the pull request automatically/, change);
    } finally { item.close(); }
  }
});

test("shutdown waits for a pending push, and a hook refusal after stopStarts cannot start a fix run", async () => {
  const item = fixture();
  try {
    item.board.setAutoPullRequest(item.repoBoard.id, true);
    await later();
    const card = item.reviewedCard();
    const worker = new Worker(item.board, join(tmpdir(), "alice-unused-data"), "pi", "");
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), inPush = new Promise<void>(resolve => { reached = resolve; });
    let startedFixRun: boolean | undefined;
    const auto = new AutoPullRequest(item.board, () => "f".repeat(64), item.draft, async current => {
      reached(); await gate;
      // What a pre-push hook refusal does in sendBackRefusedPush.
      item.board.recordPushFailure(current.id, "abc", "hook output");
      startedFixRun = worker.startHookFix(current);
      return current;
    });
    const ticking = auto.tick();
    await inPush;
    worker.stopStarts();
    let drained = false;
    const draining = auto.drain().then(() => { drained = true; });
    await later();
    assert.equal(drained, false, "drain waits for the push in progress");
    release(); await ticking; await draining;
    assert.equal(startedFixRun, false, "no run starts once shutdown began");
    assert.equal(item.board.getCiFeedback(card.id)?.source, "push", "the refusal stays for the next start");
    assert.equal(item.board.listRuns(card.id).length, 1);
  } finally { item.close(); }
});
