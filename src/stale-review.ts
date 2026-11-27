// Review cards drift from main while they wait. A card that has sat in Review longer than its board's threshold is
// stale: the board marks it and the daily push digest (server/push.ts) lists it. Server and UI share this rule.

/** Days a card may sit in Review before it counts as stale, for boards that never changed it. */
export const defaultStaleReviewDays = 3;
/** The largest threshold a board accepts; 0 turns the stale mark and digest off for the board. */
export const maxStaleReviewDays = 60;
const dayMs = 24 * 60 * 60_000;

type ReviewCard = { status: string; reviewSince?: string | null };

/** Whole days the card has been in Review, or null when it is not in Review. */
export function reviewAgeDays(
  card: ReviewCard,
  now = Date.now(),
): number | null {
  if (card.status !== "review" || !card.reviewSince) return null;
  const since = Date.parse(card.reviewSince);
  return Number.isNaN(since)
    ? null
    : Math.max(0, Math.floor((now - since) / dayMs));
}

/** True once the card has been in Review longer than `days`. A threshold of 0 never marks a card. */
export function isStaleReview(
  card: ReviewCard,
  days: number,
  now = Date.now(),
): boolean {
  if (days <= 0 || card.status !== "review" || !card.reviewSince) return false;
  const since = Date.parse(card.reviewSince);
  return !Number.isNaN(since) && now - since > days * dayMs;
}

export function validateStaleReviewDays(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maxStaleReviewDays
  )
    throw new Error(
      `Stale review days must be a whole number from 0 (off) to ${maxStaleReviewDays}`,
    );
  return value as number;
}
