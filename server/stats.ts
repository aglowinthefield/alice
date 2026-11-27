// Aggregates what Alice already records per card (runs, agent reviews, usage) for the Statistics page.
import type { ChurnRow, DayPoint, GroupRow, RunKind, SendBackReason, Stats } from "../shared/wire.js";
export type { ChurnRow, DayPoint, GroupRow, SendBackReason, Stats };
/** `kind` is why the run happened (src/run-kinds.ts); every kind but "first" is rework. `timedOut` is 1 when Alice killed it at the run timeout. */
export type StatsRun = { repo: string; id: string; cardId: string; attempt: number; kind: RunKind; timedOut: number; status: string; startedBy: string; agent: string; ciFix: number; startedAt: string; finishedAt: string | null; cost: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cacheTasks: number; cacheHits: number; cacheSavedMs: number };
/** `sendBack` is the reviewer's reason and requested changes when it sent the card back to the implementer, else null. */
export type StatsReview = { repo: string; cardId: string; sendBack: string | null; state: string; agent: string; startedAt: string; finishedAt: string | null; cost: number | null };
export type StatsCard = { repo: string; id: string; title: string; status: string; createdAt: string; updatedAt: string; attempts: number; reviewRounds: number; ciReworks: number };
/** One close without merging; reason is '' when the operator skipped it. */
export type StatsClose = { repo: string; at: string; reason: string };
export type StatsInput = { runs: StatsRun[]; reviews: StatsReview[]; cards: StatsCard[]; closes: StatsClose[] };
export type StatsOptions = { days: number | null; repo: string | null; now?: number };

// Keywords from the reviewer's reason and requested changes. A send-back can match several; "code" also takes those that match none.
const reasonPatterns: [Exclude<SendBackReason, "code">, RegExp][] = [
  ["verification", /\b(verif\w*|tests?|tested|testing|checks?|lint\w*|typecheck\w*|tsc|ci|reproduc\w*|evidence)\b/i],
  ["visual", /\b(screenshots?|visual\w*|ui|layout|render\w*|devices?|ios|android|mobile|simulator|viewport|dark mode|light mode|contrast)\b/i],
  ["writeup", /\b(pr (body|description|title|write-?up)|pull request (body|description|title)|write-?up|report|changelog|follow-?ups?|commit message)\b/i],
];
const codePattern = /\b(code|bugs?|logic|functions?|refactor\w*|regressions?|edge cases?|types?|errors?|handl\w*)\b/i;
export function classifySendBack(text: string): SendBackReason[] {
  const reasons: SendBackReason[] = reasonPatterns.filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason);
  if (!reasons.length || codePattern.test(text)) reasons.push("code");
  return reasons;
}

// SQLite's datetime('now') has no zone; read it as UTC like the ISO strings.
export const parseTime = (value: string | null): number | null => {
  if (!value) return null;
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(time) ? null : time;
};
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);
/** The Monday (UTC) that starts the week holding `time`. */
export const weekKey = (time: number) => {
  const day = Date.parse(dayKey(time));
  return dayKey(day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000);
};
const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const average = (values: number[]) => values.length ? sum(values) / values.length : null;
const runMinutes = (run: { startedAt: string; finishedAt: string | null }) => {
  const start = parseTime(run.startedAt), end = parseTime(run.finishedAt);
  return start !== null && end !== null && end >= start ? (end - start) / 60_000 : null;
};
const runTokens = (run: StatsRun) => sum([run.inputTokens, run.outputTokens, run.cacheReadTokens, run.cacheWriteTokens]);

function group(runs: StatsRun[], key: (run: StatsRun) => string): GroupRow[] {
  const rows = new Map<string, StatsRun[]>();
  for (const run of runs) rows.set(key(run), [...(rows.get(key(run)) ?? []), run]);
  return [...rows].map(([name, items]) => ({
    name, runs: items.length, failed: items.filter(run => run.status === "failed").length,
    cost: sum(items.map(run => run.cost)), tokens: sum(items.map(runTokens)),
    avgMinutes: average(items.map(runMinutes).filter((value): value is number => value !== null)),
  })).sort((a, b) => b.cost - a.cost || b.runs - a.runs);
}

function churn(runs: StatsRun[], reviews: StatsReview[], cards: StatsCard[]): ChurnRow[] {
  type Bucket = ChurnRow & { cardRuns: Map<string, { runs: number; cost: number }> };
  const buckets = new Map<string, Bucket>();
  const bucket = (repo: string, startedAt: string) => {
    const time = parseTime(startedAt);
    if (time === null) return undefined;
    const week = weekKey(time), key = `${repo}\t${week}`;
    let row = buckets.get(key);
    if (!row) {
      row = { repo, week, runs: 0, cards: 0, runsPerCard: null, cost: 0, reworkCost: 0, reworkShare: null, reworkByKind: {}, sendBacks: 0,
        sendBackReasons: { verification: 0, visual: 0, writeup: 0, code: 0 }, timeouts: 0, topCards: [], cardRuns: new Map() };
      buckets.set(key, row);
    }
    return row;
  };
  for (const run of runs) {
    const row = bucket(run.repo, run.startedAt);
    if (!row) continue;
    const cost = run.cost ?? 0;
    row.runs++; row.cost += cost; row.timeouts += run.timedOut ? 1 : 0;
    if (run.kind !== "first") { row.reworkCost += cost; row.reworkByKind[run.kind] = (row.reworkByKind[run.kind] ?? 0) + cost; }
    const card = row.cardRuns.get(run.cardId) ?? { runs: 0, cost: 0 };
    card.runs++; card.cost += cost;
    row.cardRuns.set(run.cardId, card);
  }
  for (const review of reviews) {
    const row = bucket(review.repo, review.startedAt);
    if (!row) continue;
    row.cost += review.cost ?? 0;
    if (review.sendBack === null) continue;
    row.sendBacks++;
    for (const reason of classifySendBack(review.sendBack)) row.sendBackReasons[reason]++;
  }
  const byId = new Map(cards.map(card => [card.id, card]));
  return [...buckets.values()].map(({ cardRuns, ...row }) => ({
    ...row, cards: cardRuns.size, runsPerCard: cardRuns.size ? row.runs / cardRuns.size : null,
    reworkShare: row.cost > 0 ? row.reworkCost / row.cost : null,
    topCards: [...cardRuns].map(([id, item]) => ({ id, title: byId.get(id)?.title ?? id, attempts: byId.get(id)?.attempts ?? item.runs, ...item }))
      .sort((a, b) => b.runs - a.runs || b.cost - a.cost || a.id.localeCompare(b.id)).slice(0, 3),
  })).sort((a, b) => b.week.localeCompare(a.week) || b.runs - a.runs || b.cost - a.cost || a.repo.localeCompare(b.repo));
}

export function buildStats(input: StatsInput, options: StatsOptions): Stats {
  const now = options.now ?? Date.now();
  const since = options.days === null ? -Infinity : now - options.days * 86_400_000;
  const inRange = (value: string | null) => (parseTime(value) ?? -Infinity) >= since;
  const inRepo = (item: { repo: string }) => !options.repo || item.repo === options.repo;
  const runs = input.runs.filter(run => inRepo(run) && inRange(run.startedAt) && run.status !== "running");
  const reviews = input.reviews.filter(review => inRepo(review) && inRange(review.startedAt));
  const cards = input.cards.filter(inRepo);
  const created = cards.filter(card => inRange(card.createdAt));
  const done = cards.filter(card => (card.status === "done" || card.status === "archived") && inRange(card.updatedAt));

  // Daily buckets cover the whole window, or run from the first record when the window is unbounded.
  const first = options.days === null
    ? Math.min(now, ...[...runs.map(run => run.startedAt), ...created.map(card => card.createdAt)].map(value => parseTime(value) ?? now))
    : now - (options.days - 1) * 86_400_000;
  const daily = new Map<string, DayPoint>();
  for (let time = Date.parse(dayKey(first)); time <= now; time += 86_400_000) {
    const date = dayKey(time);
    daily.set(date, { date, succeeded: 0, failed: 0, interrupted: 0, cost: 0, created: 0, done: 0, reviewCost: 0 });
  }
  const bucket = (value: string | null) => { const time = parseTime(value); return time === null ? undefined : daily.get(dayKey(time)); };
  for (const run of runs) {
    const point = bucket(run.startedAt);
    if (!point) continue;
    if (run.status === "failed") point.failed++; else if (run.status === "interrupted") point.interrupted++; else point.succeeded++;
    point.cost += run.cost ?? 0;
  }
  for (const review of reviews) { const point = bucket(review.startedAt); if (point) { point.cost += review.cost ?? 0; point.reviewCost += review.cost ?? 0; } }
  for (const card of created) { const point = bucket(card.createdAt); if (point) point.created++; }
  for (const card of done) { const point = bucket(card.updatedAt); if (point) point.done++; }

  const finished = runs.filter(run => run.status !== "interrupted");
  const leadHours = done.map(card => {
    const start = parseTime(card.createdAt), end = parseTime(card.updatedAt);
    return start !== null && end !== null && end >= start ? (end - start) / 3_600_000 : null;
  }).filter((value): value is number => value !== null);
  const cost = sum(runs.map(run => run.cost)) + sum(reviews.map(review => review.cost));
  const statusCounts = new Map<string, number>();
  for (const card of cards) statusCounts.set(card.status, (statusCounts.get(card.status) ?? 0) + 1);
  const closeCounts = new Map<string, number>();
  for (const close of input.closes) if (inRepo(close) && inRange(close.at)) closeCounts.set(close.reason, (closeCounts.get(close.reason) ?? 0) + 1);
  return {
    days: options.days,
    summary: {
      cardsCreated: created.length, cardsDone: done.length, runs: runs.length,
      successRate: finished.length ? finished.filter(run => run.status !== "failed").length / finished.length : null,
      cost, tokens: sum(runs.map(runTokens)),
      avgRunMinutes: average(runs.map(runMinutes).filter((value): value is number => value !== null)),
      avgLeadHours: average(leadHours),
      autoShare: runs.length ? runs.filter(run => run.startedBy === "auto").length / runs.length : null,
      reviewRounds: sum(created.map(card => card.reviewRounds)), ciReworks: sum(created.map(card => card.ciReworks)),
      agentReviews: reviews.length, agentReviewsMerged: reviews.filter(review => review.state === "merged").length,
    },
    buildCache: (() => {
      const tasks = sum(runs.map(run => run.cacheTasks)), hits = sum(runs.map(run => run.cacheHits));
      return { tasks, hits, hitRate: tasks ? hits / tasks : null, savedMinutes: sum(runs.map(run => run.cacheSavedMs)) / 60_000 };
    })(),
    daily: [...daily.values()],
    tokens: { input: sum(runs.map(run => run.inputTokens)), output: sum(runs.map(run => run.outputTokens)), cacheRead: sum(runs.map(run => run.cacheReadTokens)), cacheWrite: sum(runs.map(run => run.cacheWriteTokens)) },
    byAgent: group(runs, run => run.agent || "Unknown"),
    byRepo: group(runs, run => run.repo),
    cardStatus: [...statusCounts].map(([status, count]) => ({ status, count })),
    closeReasons: [...closeCounts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || Number(!a.reason) - Number(!b.reason) || a.reason.localeCompare(b.reason)),
    churn: churn(runs, reviews, cards),
  };
}
