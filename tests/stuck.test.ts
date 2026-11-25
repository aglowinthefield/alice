import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_TURNS_AFTER_CHANGE, IDLE_TURNS_BEFORE_CHANGE, REPEAT_LIMIT, REPEAT_WINDOW, StuckDetector } from "../server/stuck.js";

test("a run repeating one command is flagged once, at the repeat limit", () => {
  const detector = new StuckDetector();
  const reasons: (string | null)[] = [];
  for (let turn = 0; turn < 10; turn++) {
    reasons.push(detector.toolCall("bash", { command: "npm test", timeout: 600 }));
    // A read in between does not hide the loop.
    reasons.push(detector.toolCall("read", { path: `src/file-${turn}.ts` }));
    reasons.push(detector.turnEnd(false));
  }
  const flagged = reasons.filter(Boolean);
  assert.deepEqual(flagged, [`repeated the same bash call ${REPEAT_LIMIT} times in its last ${REPEAT_LIMIT * 2 - 1} tool calls`]);
  assert.equal(reasons.indexOf(flagged[0]), (REPEAT_LIMIT - 1) * 3, "flagged on the fifth identical call, not later");
});

test("argument order does not hide a repeat, but different arguments are different calls", () => {
  const same = new StuckDetector();
  const flips = Array.from({ length: REPEAT_LIMIT }, (_, i) => same.toolCall("bash", i % 2 ? { command: "ls", timeout: 5 } : { timeout: 5, command: "ls" }));
  assert.ok(flips.at(-1));
  const varied = new StuckDetector();
  assert.ok(Array.from({ length: 50 }, (_, i) => varied.toolCall("bash", { command: `grep -n step${i} server/worker.ts` })).every(reason => reason === null));
});

test("repeats spread wider than the window are not a loop", () => {
  const detector = new StuckDetector();
  const reasons: (string | null)[] = [];
  for (let i = 0; i < 100; i++) reasons.push(detector.toolCall("bash", i % (REPEAT_WINDOW / (REPEAT_LIMIT - 1)) ? { command: `cat file-${i}` } : { command: "npm test" }));
  assert.ok(reasons.every(reason => reason === null), "npm test every fifth call stays at 4 in any 20 calls");
});

test("a normal long run that keeps changing files is never flagged", () => {
  const detector = new StuckDetector();
  // 170 turns is the longest timed-out run in the sample; this one edits every 10 turns and runs the tests after each edit.
  for (let turn = 0; turn < 170; turn++) {
    const reasons = [
      detector.toolCall("read", { path: `src/module-${turn}.ts` }),
      turn % 10 === 9 ? detector.toolCall("bash", { command: "npm test" }) : null,
      detector.turnEnd(turn % 10 === 9),
    ];
    assert.deepEqual(reasons, [null, null, null], `turn ${turn}`);
  }
});

test("a run that stops changing files after it started is flagged after the idle limit, once", () => {
  const detector = new StuckDetector();
  assert.equal(detector.turnEnd(true), null);
  const reasons = Array.from({ length: IDLE_TURNS_AFTER_CHANGE + 10 }, () => detector.turnEnd(false));
  assert.equal(reasons.findIndex(Boolean), IDLE_TURNS_AFTER_CHANGE - 1);
  assert.equal(reasons.filter(Boolean).length, 1);
  assert.equal(reasons[IDLE_TURNS_AFTER_CHANGE - 1], `changed no files for ${IDLE_TURNS_AFTER_CHANGE} turns`);
});

test("a run still reading before its first change gets the longer limit", () => {
  const detector = new StuckDetector();
  const reasons = Array.from({ length: IDLE_TURNS_BEFORE_CHANGE }, () => detector.turnEnd(false));
  assert.equal(reasons.findIndex(Boolean), IDLE_TURNS_BEFORE_CHANGE - 1, `not flagged at ${IDLE_TURNS_AFTER_CHANGE} turns`);
  assert.equal(reasons.at(-1), `changed no files in ${IDLE_TURNS_BEFORE_CHANGE} turns`);
});
