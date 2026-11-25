// Where a card stands, as the UI and the CLI (scripts/cli-*.mjs) both show it. The CLI loads this file through Node's
// type stripping, so import only types here: a value import would need a ".ts" specifier Node can resolve.
import type { Card, CardStatus, ReviewAction, ReviewWait } from "./wire.js";

export const reviewActionLabels: Record<ReviewAction, string> = {
  pr_ready: "PR ready",
  accept_findings: "Accept findings",
};
export const reviewWaitLabels: Record<ReviewWait, string> = {
  agent_review: "Agent reviewing",
  ci_fix: "CI fix queued",
  github: "Waiting on GitHub",
};

/** A Review card you can act on now, rather than one an agent, CI or GitHub still has. */
export const needsYourReview = (card: Pick<Card, "status" | "reviewWait">) =>
  card.status === "review" && !card.reviewWait;

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
 * outside Bakery, or a running agent has gone `quiet`. Null when nothing is in flight.
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
