import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { classifyRuns, costByKind, reworkHeavy, type RunKind } from "../src/run-kinds.js";

const run = (attempt: number, status = "review", extra: { recoveryOf?: string; ciFix?: number } = {}) => ({ id: `r${attempt}`, attempt, status, ...extra });
const started = (attempt: number, why = "") => ({ toStatus: "running", reason: `Attempt ${attempt} started${why ? ` ${why}` : ""}` });
const kinds = (map: Map<string, RunKind>) => [...map.values()];

test("each run is classified from its recorded start reason", () => {
  const runs = [run(1), run(2), run(3), run(4), run(5), run(6), run(7)];
  const events = [
    started(1, "by auto-pickup"),
    { toStatus: "review", reason: "Attempt 1 finished" },
    started(2, "to apply the agent reviewer's requested changes"),
    started(3, "to fix failing CI on the pull request"),
    started(4, "to fix the failing pre-push hook"),
    started(5, "to make the changes requested on the pull request"),
    started(6, "in a fresh session to recover from attempt 5's rejected session history"),
    started(7, "without the narration instruction, in a fresh session, because Anthropic blocked attempt 6 as reverse engineering"),
  ];
  assert.deepEqual(kinds(classifyRuns(runs, events, new Set())), ["first", "send_back", "ci_fix", "ci_fix", "send_back", "retry", "retry"]);
});

test("runs without a telling start reason fall back to the run fields and requested review comments", () => {
  const runs = [run(1, "failed"), run(2, "review"), run(3, "review"), run(4, "interrupted"), run(5, "review", { ciFix: 1 }), run(6, "review", { recoveryOf: "r5" }), run(7)];
  // Attempt 2 had operator review comments requested on it, so attempt 3 is a send-back; attempt 7 follows a plain Review.
  const result = classifyRuns(runs, [started(3), started(7)], new Set(["r2"]));
  assert.deepEqual(kinds(result), ["first", "retry", "send_back", "rerun", "ci_fix", "retry", "rerun"]);
  assert.equal(result.get("r1"), "first", "attempt 1 is the first attempt even when it failed");
});

test("an auto-pickup start after a failed run is a retry, not a rerun", () => {
  const result = classifyRuns([run(2, "review"), run(1, "failed")], [started(1, "by auto-pickup"), started(2, "by auto-pickup")], new Set());
  assert.equal(result.get("r1"), "first");
  assert.equal(result.get("r2"), "retry");
});

test("cost by kind sums each kind and keeps agent reviews apart so the parts add up to the total", () => {
  const split = costByKind([{ kind: "first", cost: 1.25 }, { kind: "ci_fix", cost: 0.5 }, { kind: "ci_fix", cost: 0.25 }, { kind: "rerun", cost: null }], [{ cost: 0.1 }]);
  assert.deepEqual(split.kinds, [
    { kind: "first", cost: 1.25, runs: 1 },
    { kind: "ci_fix", cost: 0.75, runs: 2 },
    { kind: "rerun", cost: null, runs: 1 },
  ]);
  assert.equal(split.reviews, 0.1);
  assert.equal(costByKind([{ kind: "first", cost: 1 }]).reviews, null);
});

test("rework is heavy only when runs after the first cost over half the card", () => {
  assert.equal(reworkHeavy({ cost: 2, reworkCost: 1.01 }), true);
  assert.equal(reworkHeavy({ cost: 2, reworkCost: 1 }), false);
  assert.equal(reworkHeavy({ cost: 2, reworkCost: null }), false);
  assert.equal(reworkHeavy({ cost: 0, reworkCost: 0 }), false);
  assert.equal(reworkHeavy({ cost: null, reworkCost: 1 }), false);
});

test("a card with a first attempt and a CI fix shows both costs, summing to the card total", () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-run-kinds-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const card = board.createCard({ title: "Ship it", body: "", repo: dir });
    board.setStatus(card.id, "ready");
    const first = board.claim(card.id);
    board.recordUsage(first.id, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.75 });
    board.finish(first.id, "review");
    const fix = board.claim(card.id, "manual", "to fix failing CI on the pull request");
    board.startCiFix(card.id, fix.id, "ci");
    board.recordUsage(fix.id, { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1.5 });
    board.finish(fix.id, "review");

    const runs = board.listRunsWithKinds(card.id);
    assert.deepEqual(runs.map(item => [item.attempt, item.kind]), [[2, "ci_fix"], [1, "first"]]);
    const split = costByKind(runs);
    assert.deepEqual(split.kinds.map(part => [part.kind, part.cost]), [["first", 0.75], ["ci_fix", 1.5]]);
    const total = board.getCard(card.id)!;
    assert.equal(split.kinds.reduce((sum, part) => sum + (part.cost ?? 0), 0), total.cost);
    assert.equal(total.reworkCost, 1.5);
    assert.equal(reworkHeavy(total), true);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
