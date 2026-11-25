import { test } from "node:test";
import assert from "node:assert/strict";
import { atMachineCapacity, autoStartRefusal, machineAgentLimit, budgetReached, loopGuards, nextStartAt, reviewDiffRefusal, spendLimits, type LimitSettings } from "../server/repo-limits.js";

const stored: LimitSettings = { limitsEnabled: true, pickupConcurrency: 2, autoReviewConcurrency: 1, pickupDailyLimit: 2, pickupCostBudget: 5, autoReviewMaxFiles: 10, autoReviewMaxPatchChars: 1000 };
const off: LimitSettings = { ...stored, limitsEnabled: false };

test("spend limits apply only while the board's limits are on; the stored values are kept", () => {
  assert.deepEqual(spendLimits(stored), { dailyStarts: 2, costBudget: 5, reviewMaxFiles: 10, reviewMaxPatchChars: 1000 });
  assert.deepEqual(spendLimits(off), { dailyStarts: 0, costBudget: null, reviewMaxFiles: 0, reviewMaxPatchChars: 0 });
  const starts = ["2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z"];
  assert.equal(nextStartAt(stored, starts), "2026-01-02T00:00:00.000Z");
  assert.equal(nextStartAt(off, starts), null);
  assert.equal(budgetReached(stored, 6), true);
  assert.equal(budgetReached(off, 6), false);
  assert.match(reviewDiffRefusal(stored, { files: 11 }) ?? "", /11 changed files, over this board's auto-review limit of 10/);
  assert.match(reviewDiffRefusal(stored, { files: 1, patchChars: 2000 }) ?? "", /2000 characters/);
  assert.equal(reviewDiffRefusal(off, { files: 500, patchChars: 10_000_000 }), null);
});

test("capacity applies whether limits are on or off, and is checked first", () => {
  assert.equal(autoStartRefusal(off, { running: 2, starts: 0, cost24h: 0 })?.kind, "capacity");
  assert.equal(autoStartRefusal(off, { running: 1, starts: 99, cost24h: 99 }), null);
  assert.equal(autoStartRefusal(stored, { running: 1, starts: 2, cost24h: 0 })?.kind, "daily");
  assert.equal(autoStartRefusal(stored, { running: 1, starts: 0, cost24h: 5 })?.kind, "budget");
});

test("loop guards are fixed numbers, not board settings", () => {
  assert.equal(loopGuards.reviewerSendBacks, 2);
  assert.equal(loopGuards.ciFixRuns, 3);
  assert.deepEqual([...loopGuards.autoRetryDelaysMinutes], [1, 5, 15]);
});

test("the machine limit defaults to a quarter of the cores, at least 2, and is checked before any board limit", () => {
  assert.equal(machineAgentLimit(0, 16), 4);
  assert.equal(machineAgentLimit(0, 4), 2);
  assert.equal(machineAgentLimit(3, 16), 3);
  assert.equal(atMachineCapacity(3, 3), true);
  assert.equal(atMachineCapacity(3, 2), false);
  assert.equal(autoStartRefusal(off, { running: 0, starts: 0, cost24h: 0, machine: { setting: 2, active: 2 } })?.kind, "machine");
  assert.equal(autoStartRefusal(off, { running: 0, starts: 0, cost24h: 0, machine: { setting: 2, active: 1 } }), null);
});
