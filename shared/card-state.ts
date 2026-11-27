// Where a card stands, as the UI and the CLI (scripts/cli-*.mjs) both show it. The CLI loads this file through Node's
// type stripping, so import only types here: a value import would need a ".ts" specifier Node can resolve.
import type { Card, CardStatus, ReviewAction, ReviewWait } from "./wire.js";

export const reviewActionLabels: Record<ReviewAction, string> = {
  pr_ready: "PR ready",
  accept_findings: "Accept findings",
  agent_approved: "Agent approved",
  needs_you: "Needs you",
};
export const reviewWaitLabels: Record<ReviewWait, string> = {
  agent_review: "Agent reviewing",
  ci_fix: "CI fix queued",
  github: "Waiting on GitHub",
  rerun_queued: "Rerun queued",
};

/** A Review card you can act on now, rather than one an agent, CI or GitHub still has. */
export const needsYourReview = (card: Pick<Card, "status" | "reviewWait">) =>
  card.status === "review" && !card.reviewWait;

/** An agent reviewer approved the card; it waits only for your Approve, not for you to fix something. */
export const agentApproved = (
  card: Pick<Card, "status" | "reviewWait" | "reviewAction">,
) => needsYourReview(card) && card.reviewAction === "agent_approved";

/** The next step on a Review card you can act on, or "" while it is waiting or the step is not known yet. */
export const reviewActionText = (
  card: Pick<Card, "status" | "reviewWait" | "reviewAction">,
): string =>
  needsYourReview(card) && card.reviewAction
    ? reviewActionLabels[card.reviewAction]
    : "";

/** The label for a Review card's wait; a queued agent review says where it stands. */
export const reviewWaitText = (
  card: Pick<Card, "reviewWait" | "reviewQueue">,
): string =>
  card.reviewWait === "agent_review" && card.reviewQueue
    ? `Waiting for agent review (#${card.reviewQueue.position} of ${card.reviewQueue.of})`
    : card.reviewWait
      ? reviewWaitLabels[card.reviewWait]
      : "";

/** A running agent silent for this long is shown as quiet. Long tool calls (a test suite) can be quiet too. */
export const quietAfterMs = 5 * 60_000;

/**
 * Whether work is happening on the card right now: an agent is `working`, the card is `waiting` on something
 * outside Alice, or a running agent has gone `quiet`. Null when nothing is in flight.
 */
export function cardActivity(
  card: Pick<Card, "status" | "lastActivityAt" | "reviewWait" | "reviewQueue">,
  now = Date.now(),
  quietAfter = quietAfterMs,
): "working" | "waiting" | "quiet" | null {
  if (card.status === "running")
    return card.lastActivityAt &&
      now - Date.parse(card.lastActivityAt) > quietAfter
      ? "quiet"
      : "working";
  if (card.status === "review" && card.reviewWait)
    return card.reviewWait === "agent_review" && !card.reviewQueue
      ? "working"
      : "waiting";
  return null;
}

/** A dependency is finished once it is Done or archived. */
export const isFinished = (status: CardStatus) =>
  status === "done" || status === "archived";

/**
 * The cards this card still waits on, from the cards the caller already has. Only Today's list
 * leaves cards out, and only archived (finished) ones, so a missing dependency is skipped.
 */
export const waitingOn = <T extends Pick<Card, "id" | "status">>(
  card: Pick<Card, "blocked" | "dependsOn">,
  cards: T[],
): T[] =>
  card.blocked
    ? (card.dependsOn ?? [])
        .map((id) => cards.find((item) => item.id === id))
        .filter((item): item is T => !!item && !isFinished(item.status))
    : [];

/**
 * The search behind the command palette and the TUI's /: an item matches when its label and keywords hold every
 * word of the query. Labels that start with the first word come first; the rest keep their order.
 */
export const searchRank = <T extends { label: string; keywords?: string }>(
  items: T[],
  query: string,
) => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  const found = items.filter((item) => {
    const text = `${item.label} ${item.keywords ?? ""}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const lead = (item: T) =>
    item.label.toLowerCase().startsWith(terms[0]) ? 0 : 1;
  return found.sort((a, b) => lead(a) - lead(b));
};

// What each status asks of you on Today. Statuses not listed (Triage, Ready, Archived) stay on their boards.
export const needsYouLabels: Partial<Record<CardStatus, string>> = {
  review: "Review",
  failed: "Failed",
  interrupted: "Interrupted",
};
export const needsYouStatuses = Object.keys(needsYouLabels) as CardStatus[];
const oldestFirst = (a: Pick<Card, "updatedAt">, b: Pick<Card, "updatedAt">) =>
  a.updatedAt.localeCompare(b.updatedAt);

/**
 * Review cards in the order the queue walks them: the longest-waiting first. Cards an agent, CI or GitHub
 * still has are left out until they need you.
 */
export const reviewOrder = (cards: Card[]) =>
  cards.filter(needsYourReview).sort(oldestFirst);

/**
 * Today's lists across every board, for the web page and the terminal alike. `attention` needs you (Review, then
 * Failed and Interrupted, oldest first); `approved` waits only for your Approve, so it stays out of attention;
 * `running` is in flight, an agent's review included; `finished` is Done since `since`, newest first.
 */
export function todaySections(cards: Card[], since: string) {
  const attention = cards
    .filter(
      (card) =>
        card.status in needsYouLabels &&
        (card.status !== "review" ||
          (needsYourReview(card) && !agentApproved(card))),
    )
    .sort(
      (a, b) =>
        needsYouStatuses.indexOf(a.status) -
          needsYouStatuses.indexOf(b.status) || oldestFirst(a, b),
    );
  const approved = cards.filter(agentApproved).sort(oldestFirst);
  const running = cards.filter(
    (card) =>
      card.status === "running" ||
      (card.status === "review" && card.reviewWait),
  );
  const finished = cards
    .filter((card) => card.status === "done" && card.updatedAt > since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { attention, approved, running, finished };
}
