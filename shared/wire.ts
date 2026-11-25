// What the server sends over its HTTP API. The server, the UI (src/) and the CLI (scripts/) all read these, so each
// type is declared once here. Code in shared/ runs in the browser too: lint refuses node:* imports here.

export type CardStatus =
  | "triage"
  | "ready"
  | "running"
  | "review"
  | "failed"
  | "interrupted"
  | "done"
  | "archived";
/** A whole number from -100 to 100 (default 0); higher is picked up first. */
export type CardPriority = number;
/** Token and cost columns are null for attempts recorded before Bakery tracked usage; new attempts start at 0. */
export type UsageFields = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
};
/** See server/provider-failure.ts for what each kind means. */
export type ProviderFailureKind =
  | "invalid-history"
  | "output-blocked"
  | "billing"
  | "auth"
  | "invalid-request"
  | "rate-limit"
  | "transient"
  | "unknown";
/** Why a run happened, so a card's cost can be split into its first attempt and the rework after it. */
export type RunKind = "first" | "send_back" | "ci_fix" | "retry" | "rerun";
/** What a running Pi is doing now: its latest tool, that tool's turn, and when the tool started (ISO time). */
export type LiveActivity = { tool: string; turn: number; since: string };

/**
 * Why a Review card is not waiting for a person: an agent is reviewing it (or is about to), Bakery is about to send
 * its failing CI back to Pi, or its PR is waiting on GitHub (checks, merge queue, the merge reaching main).
 */
export type ReviewWait = "agent_review" | "ci_fix" | "github";
/**
 * What a person does next with a Review card that is their turn: approve changed files (`pr_ready`) or close a run
 * that changed none (`accept_findings`). Null while it is not their turn, while the change count is unknown, or while
 * something else (an approval in progress, a merge failure, a closed PR or failing checks) has to be dealt with first.
 * `agent_approved`: the agent reviewer approved the latest attempt and only your Approve is left. `needs_you`: the
 * agent reviewer handed the attempt to you (a finding, a failed check).
 */
export type ReviewAction =
  | "pr_ready"
  | "accept_findings"
  | "agent_approved"
  | "needs_you";
/**
 * The pull request linked to a card on a github-pr board. `prOverrideUrl` replaces the branch lookup.
 * `prPushedRunId` is the run whose work Approve last pushed to the PR; a newer run needs Approve again.
 * `prCiPending` is set while Bakery holds a CI failure to send back to Pi (waiting for the other checks to settle).
 */
export type CardPullRequest = {
  prOverrideUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: "OPEN" | "CLOSED" | "MERGED" | null;
  prChecks: string | null;
  prError: string | null;
  ciReworks: number;
  ciReworkSha: string | null;
  prPushedRunId: string | null;
  prCiPending: number;
  conflictRepairs: number;
  conflictRepairKey: string | null;
  prCommentsSeen: string | null;
};

export type Card = {
  id: string;
  title: string;
  body: string;
  repo: string;
  status: CardStatus;
  source: "manual";
  priority: CardPriority;
  idempotencyKey: string | null;
  /** Set on a job card made by a sentinel: which sentinel, which of its runs, and the finding. Null on every other card. */
  sentinelId: string | null;
  sentinelRunId: string | null;
  findingKey: string | null;
  /** Cards made from this card's plan report; null until the plan is used. Stays set if those cards are deleted. */
  createdCardIds: string[] | null;
  createdAt: string;
  updatedAt: string;
  turns: number;
  turnsIncomplete: number;
  attempts: number;
  reviewRounds: number;
  runAgent: string;
  reviewAgent: string;
  /** 1 when an older attempt or review of this card has no usage record, so its totals are a lower bound. */
  usageIncomplete: number;
  /** Spend on every run after the first attempt; null when there were none or none recorded usage. */
  reworkCost: number | null;
  /** Cards on the same board that must be Done or archived before this one starts. */
  dependsOn: string[];
  /** True while any card in dependsOn is not Done or archived. */
  blocked: boolean;
  /** Bakery merged this card into local main (local integration), not through a PR. */
  locallyMerged: boolean;
  /** The latest run ended with a `bakery-plan` block: this card produced a plan, not code. */
  planOnly: boolean;
  /** Last time the latest run's agent reported anything; null before the first run. */
  lastActivityAt: string | null;
  /** Automatic retries spent after temporary provider failures since the card's last successful run. */
  autoRetries: number;
  /** When auto-pickup may retry this Ready card after a temporary provider failure; null when no retry is waiting. */
  autoRetryAt: string | null;
  /** Set only for Review cards that are not your turn; null means a person is needed (or the card is not in Review). */
  reviewWait: ReviewWait | null;
  /** Where the card waits for an agent review to start on its board (1 is next); null when it is not queued. */
  reviewQueue: { position: number; of: number } | null;
  /** See `ReviewAction`. */
  reviewAction: ReviewAction | null;
  /** A start was asked for during a restart drain and runs after the restart. */
  startQueued: boolean;
  /** Files attached to the card, including those sent with discussion messages. */
  attachmentCount: number;
  /** A Failed card's reason in a few words (see `summarizeFailure`); null on other cards. */
  failureSummary: string | null;
  /** Done cards on a local board with a GitHub remote: is the merge on origin/main (last fetch)? */
  originMain?: "pushed" | "local";
  /** Only the card lists carry it; null when no run is in progress or it has not used a tool yet. */
  live?: LiveActivity | null;
} & UsageFields &
  CardPullRequest;

export type Run = {
  id: string;
  cardId: string;
  attempt: number;
  status: "running" | "review" | "failed" | "interrupted";
  pid: number | null;
  worktree: string | null;
  sessionId: string;
  output: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  turns: number;
  turnsIncomplete: number;
  startedBy: "manual" | "auto";
  agent: string;
  lastActivityAt: string | null;
  ciFix: number;
  /** The agent's final message, in markdown. Null for runs that never replied. */
  report: string | null;
  /** Why a failed run's provider call failed, when the error text names one; null for other failures and successes. */
  failureKind: ProviderFailureKind | null;
  /** Id of the failed run whose rejected session this run replaced with a fresh one; null for ordinary runs. */
  recoveryOf: string | null;
  /** 1 when this failed automatic run put its card back in Ready for an automatic retry, so it does not pause pickup. */
  retryScheduled: number;
  /** Files the run's work changes against main, as of the last time Bakery looked; null until it has. */
  changedFiles: number | null;
  /** Why the run happened; only a card's run list carries it (see src/run-kinds.ts). */
  kind?: RunKind;
} & UsageFields;

export type DayPoint = {
  date: string;
  succeeded: number;
  failed: number;
  interrupted: number;
  cost: number;
  created: number;
  done: number;
  reviewCost: number;
};
export type GroupRow = {
  name: string;
  runs: number;
  failed: number;
  cost: number;
  tokens: number;
  avgMinutes: number | null;
};
export type Stats = {
  days: number | null;
  summary: {
    cardsCreated: number;
    cardsDone: number;
    runs: number;
    successRate: number | null;
    cost: number;
    tokens: number;
    avgRunMinutes: number | null;
    avgLeadHours: number | null;
    autoShare: number | null;
    reviewRounds: number;
    ciReworks: number;
    agentReviews: number;
    agentReviewsMerged: number;
  };
  /** Turbo cache across runs in range; hitRate is null when no run used turbo. */
  buildCache: {
    tasks: number;
    hits: number;
    hitRate: number | null;
    savedMinutes: number;
  };
  daily: DayPoint[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  byAgent: GroupRow[];
  byRepo: GroupRow[];
  cardStatus: { status: string; count: number }[];
};

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = {
  seq: number;
  at: string;
  level: LogLevel;
  message: string;
};
