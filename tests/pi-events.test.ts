import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initialPiStreamState, reducePiEvent, reducePiLine, stuckTool, type PiEffect, type PiStreamState } from "../server/pi-events.js";

const fixtures = join(import.meta.dirname, "fixtures", "pi-events");
const worktree = "/work/card";

/** Replays a recorded stream one line at a time, a second apart, as `launchPi` feeds it. */
function replay(name: string) {
  const lines = readFileSync(join(fixtures, name), "utf8").split("\n").filter(Boolean);
  let state = initialPiStreamState();
  const effects: PiEffect[] = [];
  lines.forEach((line, index) => {
    const result = reducePiLine(state, line, { now: Date.UTC(2025, 0, 1) + index * 1000, worktree });
    state = result.state;
    effects.push(...result.effects);
  });
  return { state, effects };
}

const appended = (effects: PiEffect[]) => effects.flatMap(effect => effect.type === "append" ? [effect.text] : []);

test("a provider error followed by a successful message recovers and settles clean", () => {
  const { state, effects } = replay("provider-error-recovery.jsonl");
  assert.deepEqual(
    { settled: state.settled, aborted: state.aborted, turn: state.turn, terminalModelError: state.terminalModelError, protocolError: state.protocolError, tools: state.tools },
    { settled: true, aborted: false, turn: 3, terminalModelError: null, protocolError: null, tools: [] },
  );
  assert.deepEqual(effects.filter(effect => effect.type === "recordAgent"), [
    { type: "recordAgent", label: "anthropic/claude-opus-4" },
    { type: "recordAgent", label: "openai-codex/gpt-5" },
  ]);
  assert.deepEqual(effects.filter(effect => effect.type === "recordUsage").map(effect => effect.type === "recordUsage" && effect.usage.cost), [0.02, 0.01]);
  assert.deepEqual(effects.filter(effect => effect.type === "recordReport"), [
    { type: "recordReport", text: "Reading the feed code." },
    { type: "recordReport", text: "Fixed the feed." },
  ]);
  assert.equal(effects.filter(effect => effect.type === "completeTurn").length, 3);
  assert.deepEqual(effects.filter(effect => effect.type === "live"), [
    { type: "live", activity: { tool: "read", turn: 1, since: "2025-01-01T00:00:07.000Z" } },
  ]);
  assert.deepEqual(appended(effects), [
    "Reading the feed code.",
    "\nTurn 1: read ×1\n",
    "\nProvider request failed (HTTP 529): 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}; Pi may retry.\n",
    "Fixed the feed.",
    "\nPi recovered and continued after a provider error.\n",
  ]);
  // Only the turn that used tools lists the worktree, right after its summary.
  const snapshot = effects.findIndex(effect => effect.type === "snapshotWorktree");
  assert.deepEqual(effects[snapshot - 1], { type: "append", text: "\nTurn 1: read ×1\n" });
  assert.equal(effects.filter(effect => effect.type === "snapshotWorktree").length, 1);
});

test("a provider error with no later success stays the run's terminal error", () => {
  const { state } = replay("provider-error-recovery.jsonl");
  const failed = reducePiLine(state, JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error" } }), { now: 0, worktree });
  assert.equal(failed.state.terminalModelError, "Provider request failed");
  assert.deepEqual(failed.effects, [{ type: "append", text: "\nProvider request failed; Pi may retry.\n" }]);
});

test("an aborted run settles aborted and keeps its unfinished tool for the failure text", () => {
  const { state, effects } = replay("aborted.jsonl");
  assert.equal(state.settled, true);
  assert.equal(state.aborted, true);
  assert.equal(state.protocolError, null);
  assert.equal(state.turn, 1);
  assert.deepEqual(state.tools.map(tool => [tool.id, tool.finished, tool.failed]), [["call_1", false, false], ["call_2", true, true]]);
  assert.deepEqual(stuckTool(state), { id: "call_1", name: "bash", finished: false, failed: false, since: Date.UTC(2025, 0, 1) + 4000, detail: "npm test" });
  // The tool details strip the worktree path and redact secrets.
  assert.equal(state.tools[1].detail, "API_TOKEN=<redacted> ./deploy.sh");
  assert.deepEqual(effects.filter(effect => effect.type === "live").map(effect => effect.type === "live" && effect.activity.tool), ["bash", "bash"]);
  assert.equal(effects.some(effect => effect.type === "completeTurn" || effect.type === "snapshotWorktree"), false);
});

test("a line that is not a Pi event marks the stream invalid and the rest still applies", () => {
  const { state, effects } = replay("protocol-error.jsonl");
  assert.equal(state.protocolError, "Invalid Pi event stream");
  assert.equal(state.settled, true);
  assert.equal(state.aborted, false);
  assert.deepEqual(effects, [{ type: "append", text: "Working." }, { type: "completeTurn" }, { type: "turnEnded", edited: false }]);
});

test("the reducer leaves the state it was given untouched", () => {
  const before: PiStreamState = { ...initialPiStreamState(), turn: 1, tools: [{ id: "a", name: "read", finished: false, failed: false, since: 1, detail: "" }] };
  const frozen = structuredClone(before);
  reducePiEvent(before, { type: "tool_execution_end", toolCallId: "a", isError: true }, { now: 2, worktree });
  reducePiEvent(before, { type: "turn_end" }, { now: 2, worktree });
  reducePiEvent(before, { type: "tool_execution_start", toolCallId: "b", toolName: "bash" }, { now: 2, worktree });
  assert.deepEqual(before, frozen);
});

test("a repeated tool call id replaces the earlier call in place", () => {
  let state = initialPiStreamState();
  for (const event of [
    { type: "tool_execution_start", toolCallId: "a", toolName: "read" },
    { type: "tool_execution_start", toolCallId: "b", toolName: "bash" },
    { type: "tool_execution_start", toolCallId: "a", toolName: "edit" },
  ]) state = reducePiEvent(state, event, { now: 0, worktree }).state;
  assert.deepEqual(state.tools.map(tool => [tool.id, tool.name]), [["a", "edit"], ["b", "bash"]]);
});

test("the reducer module and everything it imports do no I/O", () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(join(import.meta.dirname, "..", "server", file), "utf8");
    for (const [, from] of source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)) {
      assert.match(from, /^\.\//, `${file} imports ${from}`);
      visit(from.slice(2).replace(/\.js$/, ".ts"));
    }
    assert.doesNotMatch(source, /\bprocess\.|\b(?:require|fetch)\(|\bimport\(/, `${file} reaches outside itself`);
  };
  visit("pi-events.ts");
  assert.deepEqual([...seen].sort(), ["agent.ts", "failure-summary.ts", "pi-events.ts", "provider-failure.ts"]);
});
