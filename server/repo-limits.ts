import { availableParallelism } from "node:os";

/**
 * Every limit on what a board may start, decided here. Call sites ask; they do not compare numbers themselves.
 *
 * - Loop guards stop automatic repair loops (send-backs, CI fixes, retries). They always apply: without them a
 *   failure can repeat forever.
 * - Capacity is how many runs and agent reviews a board runs at once. It always applies.
 * - Spend limits (daily automatic starts, daily cost budget, the largest diff the agent reviewer takes) apply only
 *   when the board's Limits switch is on. It is off by default, so a development board runs unthrottled; the stored
 *   values are kept for when it is turned on.
 */

/** Loop guards. Each stops one kind of automatic repeat; a person takes over after it. */
export const loopGuards = {
  /** Times the agent reviewer sends a card back to its implementer. */
  reviewerSendBacks: 2,
  /** Refused commit or pre-push hooks sent back to the agent in a row. */
  hookSendBacks: 2,
  /** Runs Bakery starts to fix a card's failing CI. */
  ciFixRuns: 3,
  /** Runs Bakery starts to repair a card's pull request conflicting with main. */
  conflictRepairs: 3,
  /** Runs of one card Bakery pushes to open its pull request without Approve. */
  autoPullRequestPushes: 3,
  /** Minutes before each automatic retry of a temporary provider failure; one entry per retry. */
  autoRetryDelaysMinutes: [1, 5, 15],
  /** Sentinel attempts per pull request, and open sentinel cards per board. */
  sentinelAttempts: 3,
  openSentinelCards: 5,
  /** A run is stopped after this long. */
  runTimeoutMinutes: 60,
} as const;

/** A board's stored limit settings. Spend limits use 0 or null for "none". */
export type LimitSettings = {
  limitsEnabled: boolean;
  pickupConcurrency: number;
  autoReviewConcurrency: number;
  pickupDailyLimit: number;
  pickupCostBudget: number | null;
  autoReviewMaxFiles: number;
  autoReviewMaxPatchChars: number;
};

/** The spend limits in force: the stored ones when Limits is on, none when it is off. */
export function spendLimits(board: LimitSettings): { dailyStarts: number; costBudget: number | null; reviewMaxFiles: number; reviewMaxPatchChars: number } {
  if (!board.limitsEnabled) return { dailyStarts: 0, costBudget: null, reviewMaxFiles: 0, reviewMaxPatchChars: 0 };
  return { dailyStarts: board.pickupDailyLimit, costBudget: board.pickupCostBudget, reviewMaxFiles: board.autoReviewMaxFiles, reviewMaxPatchChars: board.autoReviewMaxPatchChars };
}

/** Whether the daily start limit is used up, given the automatic starts in the last 24 hours. */
export function dailyStartsReached(board: LimitSettings, starts: number): boolean {
  const { dailyStarts } = spendLimits(board);
  return dailyStarts > 0 && starts >= dailyStarts;
}

/** When the next automatic start is allowed, if the daily limit is used up; `starts` are ISO times, oldest first. */
export function nextStartAt(board: LimitSettings, starts: string[]): string | null {
  const { dailyStarts } = spendLimits(board);
  if (dailyStarts === 0 || starts.length < dailyStarts) return null;
  return new Date(Date.parse(starts[starts.length - dailyStarts]) + 86_400_000).toISOString();
}

/** Whether the last 24 hours' spend has reached the daily cost budget. */
export function budgetReached(board: LimitSettings, cost24h: number): boolean {
  const { costBudget } = spendLimits(board);
  return costBudget !== null && cost24h >= costBudget;
}

/**
 * Machine capacity: agents (card runs plus agent reviews) at once across every board. Each one ends with the
 * repository's tests, often headless browsers, so boards that are each within their own concurrency can still
 * swamp the machine together. `setting` is the stored value; 0 means automatic, a quarter of the CPU cores.
 */
export function machineAgentLimit(setting: number, cores = availableParallelism()): number {
  return setting > 0 ? setting : Math.max(2, Math.floor(cores / 4));
}
/** The most agents a person may allow at once. */
export const maxMachineAgents = 32;
/** Whether automatic work must wait for an agent slot. A run a person starts counts but is never refused. */
export function atMachineCapacity(setting: number, active: number): boolean {
  return active >= machineAgentLimit(setting);
}

/** Whether the board already runs as many cards as it may. */
export function atRunCapacity(board: LimitSettings, running: number): boolean {
  return running >= board.pickupConcurrency;
}

/** Whether the board already runs as many agent reviews as it may. */
export function atReviewCapacity(board: LimitSettings, reviewing: number): boolean {
  return reviewing >= board.autoReviewConcurrency;
}

/**
 * Why automatic pickup may not start another card on this board right now, or null when it may. `wait` means a slot
 * frees by itself (a run finishes, the 24-hour window moves); `budget` means spend has to age out or the budget rise.
 */
export function autoStartRefusal(board: LimitSettings, usage: { running: number; starts: number; cost24h: number; machine?: { setting: number; active: number } }): { kind: "machine" | "capacity" | "daily" | "budget"; reason: string } | null {
  if (usage.machine && atMachineCapacity(usage.machine.setting, usage.machine.active))
    return { kind: "machine", reason: `Bakery is running ${usage.machine.active} agents, its limit across all boards` };
  if (atRunCapacity(board, usage.running)) return { kind: "capacity", reason: `at its ${board.pickupConcurrency}-run concurrency limit` };
  if (dailyStartsReached(board, usage.starts)) return { kind: "daily", reason: `used its ${board.pickupDailyLimit} automatic starts for the last 24 hours` };
  if (budgetReached(board, usage.cost24h)) return { kind: "budget", reason: "reached its daily cost budget" };
  return null;
}

/** Why the agent reviewer may not take this diff, or null. A larger diff goes to a person. */
export function reviewDiffRefusal(board: LimitSettings, diff: { files: number; patchChars?: number | null }): string | null {
  const { reviewMaxFiles, reviewMaxPatchChars } = spendLimits(board);
  if (reviewMaxFiles > 0 && diff.files > reviewMaxFiles)
    return `Diff has ${diff.files} changed files, over this board's auto-review limit of ${reviewMaxFiles}; review it yourself, or raise the limit in the board settings`;
  if (reviewMaxPatchChars > 0 && diff.patchChars != null && diff.patchChars > reviewMaxPatchChars)
    return `Diff is ${Number.isFinite(diff.patchChars) ? `${diff.patchChars} characters` : "very large"}, over this board's auto-review limit of ${reviewMaxPatchChars}; review it yourself, or raise the limit in the board settings`;
  return null;
}

/** Whether the reviewer needs the patch size at all, which costs a full diff. */
export const needsPatchSize = (board: LimitSettings) => spendLimits(board).reviewMaxPatchChars > 0;
