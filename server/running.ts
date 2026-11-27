import type { Board, Run } from "./board.js";
import type { LiveActivity } from "./pi-events.js";

/** One row of `GET /api/running`. `queued` rows have a null `startedAt`. */
export type RunningItem = { kind: "run" | "review" | "draft" | "pr"; cardId: string; boardId: string; repo: string; title: string; startedAt: string | null; tool: string; queued: boolean };

/** The schedulers' state at one moment; see `runningWork`. */
export type RunningSources = {
  runs: { run: Run; live: LiveActivity | null }[];
  reviews: { runId: string; cardId: string; tool: string }[];
  drafts: { cardId: string; since: number | null; step: string }[];
  /** Automatic pull request openings in progress, by card, with when each started. */
  opening: ReadonlyMap<string, number>;
  /** Whether the build has pull requests; without them nothing opens one automatically. */
  pullRequests: boolean;
};

/**
 * What Bakery does on every visible board without the operator, for `bakery-cli running`. Going now: runs, reviewer
 * agents, PR drafts, and automatic PR openings (`pr`, one row per card, showing its draft's step while it drafts).
 * Queued: hook fixes waiting for a run slot, PR drafts waiting for a drafting slot, and cards waiting to have their PR
 * opened automatically. `tool` is the agent's latest tool call or a draft's latest step, "" before the first.
 */
export function runningWork(board: Board, { runs, reviews, drafts, opening, pullRequests }: RunningSources): RunningItem[] {
  const boards = new Map(board.listBoards().map(item => [item.repo, item.id]));
  const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
  const item = (kind: RunningItem["kind"], cardId: string, startedAt: string | null, tool: string): RunningItem[] => {
    const card = board.getCard(cardId), boardId = card && boards.get(card.repo);
    return card && boardId ? [{ kind, cardId, boardId, repo: card.repo, title: card.title, startedAt, tool, queued: startedAt === null }] : [];
  };
  const openingStep = (cardId: string) => {
    const draft = drafts.find(entry => entry.cardId === cardId);
    return !draft ? "pushing" : draft.since === null ? "waiting for a draft slot" : draft.step || "drafting";
  };
  return [
    ...runs.flatMap(({ run, live }) => item("run", run.cardId, run.startedAt, live?.tool ?? "")),
    ...reviews.flatMap(review => item("review", review.cardId, board.getAutoReviewJob(review.runId)?.startedAt ?? "", review.tool)),
    ...[...opening].flatMap(([cardId, since]) => item("pr", cardId, iso(since), openingStep(cardId))),
    ...drafts.filter(draft => !opening.has(draft.cardId)).flatMap(draft => item("draft", draft.cardId, iso(draft.since), draft.step)),
    ...board.listWaitingHookFixes().flatMap(card => item("run", card.id, null, "")),
    ...(pullRequests ? board.listAutoPullRequestCandidates().filter(({ card }) => !opening.has(card.id)).flatMap(({ card }) => item("pr", card.id, null, "")) : []),
  ];
}
