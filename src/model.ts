import type { SemanticTitleRules } from "./pr-title.js";
import type { ThemeName } from "./themes.js";
import type { UsageFields } from "./usage.js";
import type {
  AgentModels,
  BoardAgentModels,
  ThinkingLevel,
} from "../shared/agent-models.js";
import type { Card, CardPriority, CardStatus } from "../shared/wire.js";
import type { RepoColor, RepoIcon } from "./repo-appearance.js";

export type { Card, ReviewAction, ReviewWait, Run } from "../shared/wire.js";
export {
  agentApproved,
  cardActivity,
  needsYouLabels,
  needsYouStatuses,
  needsYourReview,
  quietAfterMs,
  reviewActionLabels,
  reviewActionText,
  reviewOrder,
  reviewWaitLabels,
  reviewWaitText,
  searchRank,
  todaySections,
  waitingOn,
} from "../shared/card-state.js";
export type Status = CardStatus;
export type Board = {
  id: string;
  repo: string;
  icon: RepoIcon;
  color: RepoColor;
  remoteUrl?: string;
  /** local: Approve merges into local main. github-pr: Approve opens a PR; Done once it merges on GitHub. */
  integration?: "local" | "github-pr";
  /** What is stored: "github-pr" while pull requests are off in this build, where `integration` reads "local". */
  integrationConfigured?: "local" | "github-pr";
  /** Why GitHub sync last failed; auto pickup waits while it is set. */
  integrationError?: string;
  /** A sync problem Alice is retrying (a failed fetch); pickup is not paused. */
  integrationWarning?: string;
  /** When GitHub sync last completed. */
  integrationSyncedAt?: string | null;
  /** The operator picked the integration mode; detection leaves it alone. */
  integrationChosen?: boolean;
  /** Whether GitHub main only accepts pull requests; null until Alice could check. */
  githubMainProtected?: boolean | null;
  /** What the GitHub main check found, or why it could not run. */
  integrationNote?: string;
  autoCollapseEmptySwimlanes: boolean;
  pushMainAfterMerge?: boolean;
  /** Build caches card worktrees share with the main checkout (shared/shared-caches.ts). */
  sharedCaches?: string[];
  autoPullRequestEnabled?: boolean;
  autoReviewEnabled: boolean;
  autoReviewEnabledAt: string | null;
  /** Spend limits (daily starts, cost budget, review diff caps) apply only when on; off by default. */
  limitsEnabled?: boolean;
  autoReviewConcurrency?: number;
  autoReviewMaxFiles?: number;
  autoReviewMaxPatchChars?: number;
  autoPickupEnabled: boolean;
  pickupConcurrency: number;
  pickupDailyLimit: number;
  autoPickupStarts: number;
  autoPickupNextAt: string | null;
  autoPickupEnabledAt: string | null;
  autoPickupError: string;
  pickupCostBudget?: number | null;
  cost24h?: number;
  autoPickupBudgetReached?: boolean;
  agentModels?: BoardAgentModels;
  /** Per status; `review` counts only Review cards that need you, `reviewWaiting` the rest. */
  cardCounts?: Partial<Record<CountKey, number>>;
  /** Cards created outside this UI that the operator has not opened the board to see yet. */
  newCards?: number;
  /** Finished chat turns the operator has not seen, summed over the board's chats. */
  chatUnread?: number;
  /** Sentinel jobs that are running or queued to start. Done jobs never count. */
  sentinelsInProgress?: number;
  /** Files that keep conflicting on this board and have not been dismissed since their last conflict. */
  conflictHotspots?: ConflictHotspot[];
};
/** A file that conflicted on `cards` distinct cards within `conflictHotspotDays`. */
export type ConflictHotspot = {
  file: string;
  cards: number;
  cardIds: string[];
  lastAt: string;
};
/** A file conflicting on this many cards within `conflictHotspotDays` gets a board notice. */
export const conflictHotspotCards = 3;
export const conflictHotspotDays = 14;
export type AutoReviewJob = {
  cardId: string;
  runId: string;
  state: "running" | "needs_human" | "approved" | "merged" | "pull_request";
  details: string;
  fingerprint: string;
  startedAt: string;
  finishedAt: string | null;
  agent: string;
  /** Restarts that cut this review off. */
  interruptions: number;
  /** 1 when a restart cut the review off and it is queued to run again. */
  requeued: number;
  /** JSON list of `{ path, line?, comment }` the agent reviewer sent the card back with; empty when none. */
  changes: string;
} & UsageFields;
export type AliceSettings = {
  confirmRunStart: boolean;
  notifyOnReview: boolean;
  cardDetailsLayout: "dialog" | "side";
  theme: ThemeName;
  density: "compact" | "default" | "cozy";
  showCardModels?: boolean;
  agentModels?: AgentModels;
  discordWebhookUrl?: string;
  telemetryEnabled?: boolean;
  /** Agents at once across every board; 0 means automatic. */
  maxActiveAgents?: number;
  /** The limit in force (automatic resolved) and the agents running now. */
  activeAgentsLimit?: number;
  activeAgents?: number;
  /** False when the server has no ALICE_TELEMETRY_ENDPOINT; the toggle is then hidden. */
  telemetryAvailable?: boolean;
};
export type ReviewComment = {
  id: string;
  cardId: string;
  runId: string;
  fingerprint: string;
  path: string;
  line: number;
  fileLine: number | null;
  kind: "add" | "remove" | "context";
  code: string;
  body: string;
  state: "draft" | "requested";
  createdAt: string;
};
export type MergeConflict = {
  cardId: string;
  files: string[];
  details: string;
};
/** The Approve dialog's starting point for a new pull request; see server/pr-draft.ts. */
export type PullRequestDraft = {
  title: string;
  body: string;
  source: "agent" | "card";
  problem: string;
  templatePath: string | null;
  semantic: SemanticTitleRules | null;
  /** The repository's hooks on this run's work, checked when it reached Review; null when they were not. */
  hooks?: {
    state: "queued" | "running" | "passed" | "failed" | "unchecked";
    candidate: string | null;
    detail: string;
    /** On "failed": the hook that refused, a commit hook (nothing was committed) or the pre-push hook. */
    hook?: "commit" | "push";
  } | null;
};
export type ReviewDiff = {
  cardId: string;
  fingerprint: string;
  files: { path: string; patch: string }[];
};
export type Priority = CardPriority;
export const PRIORITY_MIN = -100;
export const PRIORITY_MAX = 100;
export const priorityLabel = (value: number) =>
  value > 0
    ? `Priority ${value}`
    : value < 0
      ? `Priority ${value} (below normal)`
      : "Normal priority";
/** Parse a typed priority; null when it is not a whole number in range. */
export const parsePriorityInput = (text: string): Priority | null => {
  const value = Number(text);
  return text.trim() !== "" &&
    Number.isInteger(value) &&
    value >= PRIORITY_MIN &&
    value <= PRIORITY_MAX
    ? value
    : null;
};
/** Warmer for higher priority: grey at 0, amber from 1, orange from 50, red from 90. */
export const priorityTone = (value: number) =>
  value >= 90
    ? "text-red-400"
    : value >= 50
      ? "text-orange-400"
      : value > 0
        ? "text-amber-400"
        : "text-muted-foreground";
// Stable sort: equal priorities keep the server's existing order.
export const byPriority = <T extends { priority?: number }>(items: T[]) =>
  [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
export const cardSorts = {
  priority: "Priority",
  updated: "Recently updated",
  newest: "Newest",
  oldest: "Oldest",
  title: "Title",
} as const;
export type CardSort = keyof typeof cardSorts;
export const isCardSort = (value: unknown): value is CardSort =>
  typeof value === "string" && Object.hasOwn(cardSorts, value);
type Sortable = {
  title: string;
  priority?: number;
  createdAt: string;
  updatedAt: string;
};
const time = (value: string) => Date.parse(value) || 0;
/** Orders a lane's cards. Ties fall back to priority, then the server's order. */
export const sortCards = <T extends Sortable>(items: T[], sort: CardSort) => {
  const prioritized = byPriority(items);
  if (sort === "priority") return prioritized;
  const compare: Record<
    Exclude<CardSort, "priority">,
    (a: T, b: T) => number
  > = {
    updated: (a, b) => time(b.updatedAt) - time(a.updatedAt),
    newest: (a, b) => time(b.createdAt) - time(a.createdAt),
    oldest: (a, b) => time(a.createdAt) - time(b.createdAt),
    title: (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  };
  return prioritized.sort(compare[sort]);
};
export type CountKey = Status | "reviewWaiting";
/** The `cardCounts` bucket a card falls in. */
export const countKey = (card: Card): CountKey =>
  card.status === "review" && card.reviewWait ? "reviewWaiting" : card.status;

/**
 * Lanes a board card can be dragged to. Mirrors the card's own buttons: Move to Ready or Triage,
 * Mark done (never-run cards only), Start or Run again, Archive, and Restore to Done. Moves that need
 * a diff review, an approval, or a worktree check (Review, Interrupted, Reopen) stay as buttons.
 */
export function dropTargets(card: Card): Status[] {
  const unrun = !card.attempts;
  // The server refuses to start a never-run card whose dependencies are unfinished.
  if (card.status === "ready" && unrun && card.blocked)
    return ["triage", "done"];
  switch (card.status) {
    case "triage":
      return unrun ? ["ready", "done"] : ["ready"];
    case "ready":
      return unrun ? ["triage", "running", "done"] : ["running"];
    case "failed":
      return ["ready", "running"];
    case "done":
      return ["archived"];
    case "archived":
      return ["done"];
    default:
      return [];
  }
}
/** The lanes every one of these cards can move to, so a bulk move never half-applies. */
export const sharedDropTargets = (cards: Card[]): Status[] =>
  cards.length === 0
    ? []
    : cards
        .map(dropTargets)
        .reduce((shared, targets) =>
          shared.filter((status) => targets.includes(status)),
        );
/**
 * The Triage cards that move to Ready along with a Triage card: everything it waits on that is still in
 * Triage, and what those wait on in turn. Cards already further along are left out and not followed.
 */
export const readyCompanions = (card: Card, cards: Card[]): Card[] => {
  if (card.status !== "triage") return [];
  const byId = new Map(cards.map((item) => [item.id, item]));
  const seen = new Set([card.id]);
  const found: Card[] = [];
  const queue = [card];
  for (let next = queue.shift(); next; next = queue.shift())
    for (const id of next.dependsOn ?? []) {
      const parent = byId.get(id);
      if (!parent || parent.status !== "triage" || seen.has(id)) continue;
      seen.add(id);
      found.push(parent);
      queue.push(parent);
    }
  return found;
};

/** A file attached to a card, or to one of its discussion messages (`messageId`). */
export type Attachment = {
  id: string;
  cardId: string;
  messageId: string | null;
  name: string;
  type: string;
  size: number;
  createdAt: string;
};

/** One message in a card's Discuss chat; "error" is a failed agent reply. */
export type DiscussionMessage = {
  id: string;
  cardId: string;
  role: "user" | "agent" | "error";
  body: string;
  createdAt: string;
  attachments: Attachment[];
};

/**
 * A board chat: a general agent session about one repo. `title` is the first line of the first message, `topic` a
 * few-word summary of it (empty until written). `pending` is set while the agent is replying. `unread` counts agent
 * turns that finished while nobody was looking at the chat.
 */
export type Chat = {
  id: string;
  boardId: string;
  title: string;
  /** Pi model and thinking level for this chat's turns; "" leaves it to Pi's default. */
  model: string;
  thinking: ThinkingLevel | "";
  topic?: string;
  unread?: number;
  createdAt: string;
  updatedAt: string;
  pending?: boolean;
};
/** What an agent turn did, in order: reply text and the tools it ran. */
export type ChatPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: string;
      output: string;
      status: "running" | "done" | "error";
    };
export type ChatMessage = {
  id: string;
  chatId: string;
  role: "user" | "agent" | "error";
  body: string;
  parts: ChatPart[];
  createdAt: string;
};
/** The reply being written; null when the agent is idle. */
export type ChatLive = { startedAt: string; parts: ChatPart[] } | null;
/** `items` sorted by the saved id order; ids not in the order (new repos) keep their place after the ordered ones. */
export function applyOrder<T extends { id: string }>(
  items: T[],
  order: string[],
) {
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index)
    .map((entry) => entry.item);
}
/** The ids of `items` with `from` moved to sit before `before`, or to the end when `before` is null. */
export function moveId(
  items: { id: string }[],
  from: string,
  before: string | null,
) {
  const ids = items.map((item) => item.id).filter((id) => id !== from);
  const at = before === null ? -1 : ids.indexOf(before);
  ids.splice(at === -1 ? ids.length : at, 0, from);
  return ids;
}

export type SentinelKind = "pr-health" | "pr-requests";
/** A persistent monitor. Not a card: it has no lane and no Review or Done. `enabled` false is paused. */
export type Sentinel = {
  id: string;
  boardId: string;
  kind: SentinelKind;
  instructions: string;
  scope: string;
  intervalMs: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
};
export type SentinelFinding = {
  key: string;
  cardId: string;
  outcome: "created" | "open" | "withdrawn";
};
export type SentinelRun = {
  id: string;
  sentinelId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  findings: SentinelFinding[];
  summary: string;
  error: string | null;
};
export type SentinelOverview = {
  sentinel: Sentinel;
  name: string;
  running: boolean;
  runs: SentinelRun[];
  jobs: Card[];
};
