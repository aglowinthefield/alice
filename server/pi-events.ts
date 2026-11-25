// Reads Pi's JSON event stream (`pi --mode json`) as a pure reducer, so a run's stream can be replayed from its log
// after a server restart. No I/O here: the caller splits lines, passes the clock in, and applies the effects.
import { agentLabel, messageUsage, type Usage } from "./agent.js";
import { describeToolCall } from "./failure-summary.js";

/** What a running Pi is doing now: its latest tool, that tool's turn, and when the tool started (ISO time). */
export type LiveActivity = { tool: string; turn: number; since: string };

/** One tool call in the current turn. `since` is the epoch milliseconds it started. */
export type PiTool = { id: string; name: string; finished: boolean; failed: boolean; since: number; detail: string };

export type PiStreamState = {
  /** Pi sent `agent_settled`; `aborted` is that event's flag. */
  settled: boolean;
  aborted: boolean;
  /** Tool calls since the last `turn_start` or `turn_end` summary, in start order. */
  tools: readonly PiTool[];
  /** Turns started so far. */
  turn: number;
  /** The latest provider failure, cleared when a later assistant message succeeds. */
  terminalModelError: string | null;
  protocolError: string | null;
  /** The last agent label recorded, so each switch is recorded once. */
  lastAgent: string;
};

export type PiEffect =
  | { type: "append"; text: string }
  | { type: "recordAgent"; label: string }
  | { type: "recordUsage"; usage: Usage }
  | { type: "recordReport"; text: string }
  | { type: "completeTurn" }
  | { type: "live"; activity: LiveActivity }
  /** A tool call started, with its raw arguments, for stuck detection (server/stuck.ts). Never stored. */
  | { type: "toolStarted"; name: string; args: unknown }
  /** A turn ended; `edited` says an edit or write call in it succeeded. The caller checks the worktree for other changes. */
  | { type: "turnEnded"; edited: boolean }
  /** Turn end with tools used: list the worktree's changed files in the transcript (runs Git, so the caller does it). */
  | { type: "snapshotWorktree" };

export type PiEventContext = { now: number; worktree: string };

export const INVALID_STREAM = "Invalid Pi event stream";

export function initialPiStreamState(): PiStreamState {
  return { settled: false, aborted: false, tools: [], turn: 0, terminalModelError: null, protocolError: null, lastAgent: "" };
}

// Keep Pi's error text so the card shows why the provider call failed; cap it so one line cannot flood the transcript.
export function providerFailure(error: unknown): string {
  const text = typeof error === "string" ? error.trim() : "";
  const status = text.match(/\b[45]\d{2}\b/)?.[0];
  return `Provider request failed${status ? ` (HTTP ${status})` : ""}${text ? `: ${text.slice(0, 1000)}` : ""}`;
}

/** One line of Pi's stdout. A line that is not JSON marks the stream invalid and changes nothing else. */
export function reducePiLine(state: PiStreamState, line: string, context: PiEventContext): { state: PiStreamState; effects: PiEffect[] } {
  let event: unknown;
  try { event = JSON.parse(line); }
  catch { return { state: { ...state, protocolError: INVALID_STREAM }, effects: [] }; }
  return reducePiEvent(state, event, context);
}

/**
 * One parsed Pi event. An event that breaks the handler partway (`null`, say) keeps the effects and state reached
 * before the break and marks the stream invalid, as the inline handler did.
 */
export function reducePiEvent(previous: PiStreamState, input: unknown, { now, worktree }: PiEventContext): { state: PiStreamState; effects: PiEffect[] } {
  const state = { ...previous, tools: [...previous.tools] };
  const effects: PiEffect[] = [];
  // Pi's events are loosely typed JSON; the checks below mirror what each field is used for.
  // oxlint-disable-next-line typescript/no-explicit-any
  const event = input as any;
  try {
    if (event.type === "agent_settled") { state.settled = true; state.aborted = event.aborted === true; }
    if (event.type === "message_start" || event.type === "message_end") {
      const label = agentLabel(event.message);
      if (label && label !== state.lastAgent) { state.lastAgent = label; effects.push({ type: "recordAgent", label }); }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const usage = messageUsage(event.message);
      if (usage) effects.push({ type: "recordUsage", usage });
      if (event.message.stopReason !== "error" && Array.isArray(event.message.content))
        effects.push({ type: "recordReport", text: event.message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: unknown }) => typeof part.text === "string" ? part.text : "").join("") });
      if (event.message.stopReason === "error") {
        state.terminalModelError = providerFailure(event.message.errorMessage);
        effects.push({ type: "append", text: `\n${state.terminalModelError}; Pi may retry.\n` });
      } else if (state.terminalModelError) {
        state.terminalModelError = null;
        effects.push({ type: "append", text: "\nPi recovered and continued after a provider error.\n" });
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") effects.push({ type: "append", text: event.assistantMessageEvent.delta });
    if (event.type === "turn_start") { state.turn++; state.tools = []; }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      const name = typeof event.toolName === "string" && /^[a-z][a-z0-9_-]{0,40}$/i.test(event.toolName) ? event.toolName : "tool";
      const tool: PiTool = { id: event.toolCallId, name, finished: false, failed: false, since: now, detail: describeToolCall(event.args, worktree) };
      // A repeated id replaces the earlier call in place, as a Map keyed by id would.
      const index = state.tools.findIndex(item => item.id === tool.id);
      if (index >= 0) state.tools[index] = tool; else state.tools.push(tool);
      effects.push({ type: "live", activity: { tool: name, turn: state.turn || 1, since: new Date(now).toISOString() } });
      effects.push({ type: "toolStarted", name, args: event.args });
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const index = state.tools.findIndex(item => item.id === event.toolCallId);
      if (index >= 0) state.tools[index] = { ...state.tools[index], finished: true, failed: event.isError === true };
    }
    if (event.type === "turn_end") {
      effects.push({ type: "completeTurn" });
      effects.push({ type: "turnEnded", edited: state.tools.some(tool => tool.finished && !tool.failed && (tool.name === "edit" || tool.name === "write")) });
    }
    if (event.type === "turn_end" && state.tools.length) {
      const counts = new Map<string, number>();
      let failed = 0, unfinished = 0;
      for (const tool of state.tools) {
        counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
        if (!tool.finished) unfinished++;
        else if (tool.failed) failed++;
      }
      const summary = [...counts].map(([name, count]) => `${name} ×${count}`).join(", ");
      effects.push({ type: "append", text: `\nTurn ${state.turn || 1}: ${summary}${failed ? `; ${failed} failed` : ""}${unfinished ? `; ${unfinished} unfinished` : ""}\n` });
      effects.push({ type: "snapshotWorktree" });
      state.tools = [];
    }
  } catch { state.protocolError = INVALID_STREAM; }
  return { state, effects };
}

/** The oldest tool call still running, which a killed run was most likely stuck in. */
export function stuckTool(state: PiStreamState): PiTool | undefined {
  return state.tools.filter(tool => !tool.finished).sort((a, b) => a.since - b.since)[0];
}
