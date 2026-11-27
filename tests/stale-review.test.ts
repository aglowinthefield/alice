import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Board } from "../server/board.js";
import { currentMainInstructions } from "../server/worker.js";
import { defaultStaleReviewDays, isStaleReview, reviewAgeDays, validateStaleReviewDays } from "../src/stale-review.js";

const day = 24 * 60 * 60_000;
const now = Date.parse("2026-05-10T12:00:00.000Z");
const inReview = (daysAgo: number) => ({ status: "review", reviewSince: new Date(now - daysAgo * day).toISOString() });

test("a 4-day-old Review card is stale at the default 3 days; a 1-day-old one is not", () => {
  assert.equal(defaultStaleReviewDays, 3);
  assert.equal(isStaleReview(inReview(4), defaultStaleReviewDays, now), true);
  assert.equal(isStaleReview(inReview(1), defaultStaleReviewDays, now), false);
  assert.equal(reviewAgeDays(inReview(4), now), 4);
});

test("the threshold is exclusive, per board, 0 turns it off, and only Review cards count", () => {
  assert.equal(isStaleReview(inReview(3), 3, now), false, "exactly the threshold is not yet stale");
  assert.equal(isStaleReview(inReview(3.01), 3, now), true);
  assert.equal(isStaleReview(inReview(4), 5, now), false, "a board with a longer threshold");
  assert.equal(isStaleReview(inReview(4), 1, now), true, "a board with a shorter threshold");
  assert.equal(isStaleReview(inReview(400), 0, now), false);
  assert.equal(isStaleReview({ status: "ready", reviewSince: inReview(9).reviewSince }, 3, now), false);
  assert.equal(isStaleReview({ status: "review", reviewSince: null }, 3, now), false);
  assert.equal(reviewAgeDays({ status: "done", reviewSince: null }, now), null);
  assert.throws(() => validateStaleReviewDays(-1), /0 \(off\) to 60/);
  assert.throws(() => validateStaleReviewDays(1.5), /whole number/);
  assert.throws(() => validateStaleReviewDays("3"), /whole number/);
  assert.equal(validateStaleReviewDays(0), 0);
});

test("a Review card carries when it entered Review, and each board keeps its own threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-stale-")), repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hi\n");
  const board = new Board(join(dir, "board.sqlite"));
  try {
    const repoBoard = board.addRepo(repo);
    assert.equal(repoBoard.staleReviewDays, 3);
    const card = board.createCard({ repo, title: "Waits", body: "" });
    board.setStatus(card.id, "ready");
    assert.equal(board.getCard(card.id)!.reviewSince, null);
    const run = board.claim(card.id);
    const before = Date.now();
    board.finish(run.id, "review");
    const since = Date.parse(board.getCard(card.id)!.reviewSince!);
    assert.ok(since >= before - 1000 && since <= Date.now() + 1000, "set when the run reached Review");
    assert.equal(isStaleReview(board.getCard(card.id)!, 3, since + 4 * day), true);
    assert.equal(isStaleReview(board.getCard(card.id)!, 3, since + day), false);
    assert.equal(board.setStaleReviewDays(repoBoard.id, 7).staleReviewDays, 7);
    assert.equal(board.listBoards()[0].staleReviewDays, 7);
    assert.throws(() => board.setStaleReviewDays(repoBoard.id, 61), /0 \(off\) to 60/);
  } finally { board.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Run again on current main tells the agent which main to catch up with, without committing local work", () => {
  const local = currentMainInstructions(false, "abc123");
  assert.match(local, /current local `main` \(abc123\)/);
  assert.match(local, /Do not commit the card's work/);
  const pr = currentMainInstructions(true, "");
  assert.match(pr, /contains current origin\/main: check/);
  assert.match(pr, /commit the merge there/);
});
