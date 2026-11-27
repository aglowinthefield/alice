import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Board } from "../server/board.js";
import { buildStats, classifySendBack, weekKey } from "../server/stats.js";

const timeout = "Pi exited (null); Bakery sent SIGTERM: 90-minute run timeout; no tool was running; no settlement event";

// Two boards over two weeks (Mondays 2026-03-02 and 2026-03-09), plus a sentinel card the Statistics page never counts.
function fixture(board: Board) {
  const db = board.sqlite;
  const card = (id: string, repo: string, title: string, sentinel = false) =>
    db.prepare("INSERT INTO cards(id, title, body, repo, status, source, createdAt, updatedAt, sentinelId) VALUES (?, ?, '', ?, 'review', 'manual', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', ?)").run(id, title, repo, sentinel ? "sentinel" : null);
  const run = (id: string, cardId: string, attempt: number, startedAt: string, cost: number, status = "review", error: string | null = null) =>
    db.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, startedAt, finishedAt, cost, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, cardId, attempt, status, `s-${cardId}`, startedAt, startedAt, cost, error);
  const started = (cardId: string, reason: string) => db.prepare("INSERT INTO card_events(cardId, at, fromStatus, toStatus, reason) VALUES (?, '2026-03-01T00:00:00.000Z', 'ready', 'running', ?)").run(cardId, reason);
  const review = (cardId: string, runId: string, startedAt: string, cost: number, state: string, details: string, changes = "") =>
    db.prepare("INSERT INTO auto_review_jobs(cardId, runId, state, details, changes, startedAt, finishedAt, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(cardId, runId, state, details, changes, startedAt, startedAt, cost);

  card("a1", "/code/alpha", "Flaky login");
  run("a1-1", "a1", 1, "2026-03-03T10:00:00.000Z", 1, "failed", timeout);
  run("a1-2", "a1", 2, "2026-03-04T10:00:00.000Z", 2);
  run("a1-3", "a1", 3, "2026-03-10T10:00:00.000Z", 0.5);
  started("a1", "Attempt 2 started to apply the agent reviewer's requested changes");
  started("a1", "Attempt 3 started to fix failing CI");
  review("a1", "a1-1", "2026-03-03T12:00:00.000Z", 0.5, "needs_human", "Sent back to the implementer: Tests were not run and no screenshot is attached.",
    JSON.stringify([{ path: "src/login.ts", comment: "Fix the null check in the handler." }]));

  card("a2", "/code/alpha", "Tidy header");
  run("a2-1", "a2", 1, "2026-03-03T11:00:00.000Z", 1);
  run("a2-2", "a2", 2, "2026-03-05T11:00:00.000Z", 1);
  db.prepare("INSERT INTO review_comments(id, cardId, runId, fingerprint, path, line, kind, code, body, state, createdAt) VALUES ('rc', 'a2', 'a2-1', 'f', 'a.ts', 1, 'add', '', 'Rename this', 'requested', '2026-03-04T00:00:00.000Z')").run();
  review("a2", "a2-2", "2026-03-05T12:00:00.000Z", 0.25, "merged", "Looks right.");

  card("b1", "/code/beta", "Docs pass");
  run("b1-1", "b1", 1, "2026-03-09T10:00:00.000Z", 3);
  run("b1-2", "b1", 2, "2026-03-11T10:00:00.000Z", 1, "failed", timeout);
  review("b1", "b1-1", "2026-03-11T12:00:00.000Z", 0.75, "needs_human", "Sent back to the implementer: The PR description is missing the follow-ups.");

  card("s1", "/code/alpha", "Sentinel job", true);
  run("s1-1", "s1", 1, "2026-03-03T10:00:00.000Z", 100, "failed", timeout);
  review("s1", "s1-1", "2026-03-03T12:00:00.000Z", 9, "needs_human", "Sent back to the implementer: code");
}

test("the churn panel's numbers match hand queries over a fixture database", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-churn-"));
  const board = new Board(join(dir, "board.sqlite"));
  try {
    fixture(board);
    const churn = buildStats(board.statsInput(), { days: null, repo: null, now: Date.parse("2026-03-12T00:00:00.000Z") }).churn;
    const db = board.sqlite;
    // Week = the Monday on or before the start date. Rework = runs after the first attempt, as on the card's cost marker.
    const runs = db.prepare(`SELECT cards.repo, date(runs.startedAt, '-6 days', 'weekday 1') AS week, COUNT(*) AS runs, COUNT(DISTINCT runs.cardId) AS cards,
        SUM(runs.cost) AS cost, SUM(CASE WHEN runs.attempt > 1 THEN runs.cost ELSE 0 END) AS rework,
        SUM(COALESCE(runs.error, '') LIKE '%Bakery sent SIGTERM: %-minute run timeout%') AS timeouts
      FROM runs JOIN cards ON cards.id = runs.cardId WHERE cards.sentinelId IS NULL GROUP BY 1, 2`).all() as { repo: string; week: string; runs: number; cards: number; cost: number; rework: number; timeouts: number }[];
    const reviews = db.prepare(`SELECT cards.repo, date(job.startedAt, '-6 days', 'weekday 1') AS week, SUM(job.cost) AS cost,
        SUM(job.details LIKE 'Sent back to the implementer: %') AS sendBacks
      FROM auto_review_jobs job JOIN cards ON cards.id = job.cardId WHERE cards.sentinelId IS NULL GROUP BY 1, 2`).all() as { repo: string; week: string; cost: number; sendBacks: number }[];
    const top = db.prepare(`SELECT cards.repo, date(runs.startedAt, '-6 days', 'weekday 1') AS week, runs.cardId, COUNT(*) AS runs
      FROM runs JOIN cards ON cards.id = runs.cardId WHERE cards.sentinelId IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, COUNT(*) DESC, SUM(runs.cost) DESC`).all() as { repo: string; week: string; cardId: string; runs: number }[];

    assert.deepEqual(churn.map(row => [row.week, row.repo]), [["2026-03-09", "/code/beta"], ["2026-03-09", "/code/alpha"], ["2026-03-02", "/code/alpha"]]);
    assert.equal(runs.length, churn.length);
    for (const hand of runs) {
      const row = churn.find(item => item.repo === hand.repo && item.week === hand.week)!;
      const reviewed = reviews.find(item => item.repo === hand.repo && item.week === hand.week) ?? { cost: 0, sendBacks: 0 };
      const label = `${hand.repo} ${hand.week}`;
      assert.equal(row.runs, hand.runs, label);
      assert.equal(row.cards, hand.cards, label);
      assert.equal(row.runsPerCard, hand.runs / hand.cards, label);
      assert.equal(row.timeouts, hand.timeouts, label);
      assert.equal(row.cost, hand.cost + reviewed.cost, label);
      assert.equal(row.reworkCost, hand.rework, label);
      assert.equal(row.reworkShare, hand.rework / (hand.cost + reviewed.cost), label);
      assert.equal(row.sendBacks, reviewed.sendBacks, label);
      assert.deepEqual(row.topCards.map(card => card.id), top.filter(item => item.repo === hand.repo && item.week === hand.week).slice(0, 3).map(item => item.cardId), label);
    }

    const [beta, alphaLate, alphaEarly] = churn;
    // The rework classification splits the rework spend by why each run happened.
    assert.deepEqual(alphaEarly.reworkByKind, { send_back: 3 });
    assert.deepEqual(alphaLate.reworkByKind, { ci_fix: 0.5 });
    assert.deepEqual(beta.reworkByKind, { rerun: 1 });
    // Reason keywords come from the reviewer's reason and its requested changes.
    assert.deepEqual(alphaEarly.sendBackReasons, { verification: 1, visual: 1, writeup: 0, code: 1 });
    assert.deepEqual(beta.sendBackReasons, { verification: 0, visual: 0, writeup: 1, code: 0 });
    assert.deepEqual(alphaEarly.topCards.map(card => [card.title, card.runs, card.attempts]), [["Flaky login", 2, 3], ["Tidy header", 2, 2]]);

    const betaOnly = buildStats(board.statsInput(), { days: null, repo: "/code/beta", now: Date.parse("2026-03-12T00:00:00.000Z") }).churn;
    assert.deepEqual(betaOnly.map(row => row.repo), ["/code/beta"]);
  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send-back reasons are matched by keyword, and anything unmatched counts as code", () => {
  assert.deepEqual(classifySendBack("Run the tests and attach evidence"), ["verification"]);
  assert.deepEqual(classifySendBack("The layout breaks on an iOS device"), ["visual"]);
  assert.deepEqual(classifySendBack("Rewrite the PR body"), ["writeup"]);
  assert.deepEqual(classifySendBack("Rename the variable"), ["code"]);
  assert.deepEqual(classifySendBack("The handler throws; add a test"), ["verification", "code"]);
});

test("weeks start on Monday in UTC", () => {
  assert.equal(weekKey(Date.parse("2026-03-09T00:00:00.000Z")), "2026-03-09");
  assert.equal(weekKey(Date.parse("2026-03-15T23:59:00.000Z")), "2026-03-09");
  assert.equal(weekKey(Date.parse("2026-03-08T23:59:00.000Z")), "2026-03-02");
});
