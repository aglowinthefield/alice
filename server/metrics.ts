import { parseTime, type StatsInput } from "./stats.js";

/**
 * Prometheus metrics for the operator's own monitoring, served on GET /metrics when BAKERY_METRICS=1.
 * Unlike the anonymous telemetry, these carry repository paths and model names, so they never leave the server unless
 * something scrapes it. Every counter is derived from SQLite on each scrape, so totals survive restarts and a run
 * counts once it has finished. docs/metrics.md lists every metric.
 */

/** One run, agent review or pull request draft going now, sentinel jobs included. `startedAt` is in Unix milliseconds. */
export type ActiveWork = { kind: "run" | "agent_review" | "pr_draft"; repo: string; cardId: string; title: string; startedAt: number };
/** What is going now: the counts behind the `bakery_active_*` totals, and each piece of work for the Running now table. */
export type Live = { runs: number; reviews: number; pullRequests: number; work: ActiveWork[] };

/** Run duration buckets, in seconds: 1, 2, 5, 10, 15, 30 and 60 minutes, then 2 and 4 hours. */
const durationBuckets = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

type Labels = Record<string, string>;
type Sample = { labels: Labels; value: number };
type Family = { name: string; help: string; type: "counter" | "gauge" | "histogram"; samples: Sample[] };

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelText = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(",")}}` : "";
};
const number = (value: number) => Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : "NaN";

/** Sums values per label set, keeping the first-seen order. */
class Sums {
  private rows = new Map<string, Sample>();
  add(labels: Labels, value: number | null | undefined) {
    const key = JSON.stringify(labels);
    const row = this.rows.get(key) ?? this.rows.set(key, { labels, value: 0 }).get(key)!;
    row.value += value ?? 0;
  }
  get samples() { return [...this.rows.values()]; }
}

export function renderMetrics(input: StatsInput, live: Live, version: string): string {
  const runs = new Sums(), cost = new Sums(), tokens = new Sums(), cacheTasks = new Sums(), cacheHits = new Sums(), cacheSaved = new Sums();
  const durations = new Map<string, { labels: Labels; counts: number[]; count: number; sum: number }>();
  for (const run of input.runs) {
    if (run.status === "running") continue;
    const agent = run.agent || "unknown";
    runs.add({ repo: run.repo, agent, status: run.status, started_by: run.startedBy || "unknown" }, 1);
    cost.add({ repo: run.repo, agent }, run.cost);
    for (const [type, value] of [["input", run.inputTokens], ["output", run.outputTokens], ["cache_read", run.cacheReadTokens], ["cache_write", run.cacheWriteTokens]] as const) tokens.add({ repo: run.repo, agent, type }, value);
    cacheTasks.add({ repo: run.repo }, run.cacheTasks);
    cacheHits.add({ repo: run.repo }, run.cacheHits);
    cacheSaved.add({ repo: run.repo }, run.cacheSavedMs / 1000);
    const start = parseTime(run.startedAt), end = parseTime(run.finishedAt);
    if (start === null || end === null || end < start) continue;
    const seconds = (end - start) / 1000, labels = { repo: run.repo, agent, status: run.status }, key = JSON.stringify(labels);
    const row = durations.get(key) ?? durations.set(key, { labels, counts: durationBuckets.map(() => 0), count: 0, sum: 0 }).get(key)!;
    durationBuckets.forEach((bound, index) => { if (seconds <= bound) row.counts[index]++; });
    row.count++; row.sum += seconds;
  }
  const reviews = new Sums(), reviewCost = new Sums();
  for (const review of input.reviews) {
    if (review.state === "running") continue;
    reviews.add({ repo: review.repo, state: review.state }, 1);
    reviewCost.add({ repo: review.repo }, review.cost);
  }
  const cards = new Sums(), reviewRounds = new Sums(), ciReworks = new Sums();
  for (const card of input.cards) {
    cards.add({ repo: card.repo, status: card.status }, 1);
    reviewRounds.add({ repo: card.repo }, card.reviewRounds);
    ciReworks.add({ repo: card.repo }, card.ciReworks);
  }
  const histogram: Sample[] = [...durations.values()].flatMap(row => [
    ...durationBuckets.map((bound, index) => ({ labels: { ...row.labels, le: String(bound) }, value: row.counts[index] })),
    { labels: { ...row.labels, le: "+Inf" }, value: row.count },
  ]);
  const families: Family[] = [
    { name: "bakery_info", help: "Bakery's version.", type: "gauge", samples: [{ labels: { version }, value: 1 }] },
    { name: "bakery_runs_total", help: "Finished agent runs, by outcome: review, failed or interrupted.", type: "counter", samples: runs.samples },
    { name: "bakery_run_duration_seconds", help: "Wall time of finished agent runs.", type: "histogram", samples: histogram },
    { name: "bakery_run_cost_dollars_total", help: "Model spend of finished agent runs, in US dollars.", type: "counter", samples: cost.samples },
    { name: "bakery_run_tokens_total", help: "Tokens used by finished agent runs.", type: "counter", samples: tokens.samples },
    { name: "bakery_build_cache_tasks_total", help: "Turbo tasks in finished runs.", type: "counter", samples: cacheTasks.samples },
    { name: "bakery_build_cache_hits_total", help: "Turbo tasks served from cache in finished runs.", type: "counter", samples: cacheHits.samples },
    { name: "bakery_build_cache_saved_seconds_total", help: "Build time Turbo's cache saved in finished runs.", type: "counter", samples: cacheSaved.samples },
    { name: "bakery_agent_reviews_total", help: "Finished agent reviews, by outcome.", type: "counter", samples: reviews.samples },
    { name: "bakery_agent_review_cost_dollars_total", help: "Model spend of agent reviews, in US dollars.", type: "counter", samples: reviewCost.samples },
    { name: "bakery_card_review_rounds_total", help: "Times an operator requested changes on a card's run.", type: "counter", samples: reviewRounds.samples },
    { name: "bakery_card_ci_reworks_total", help: "Times a card went back to its agent to fix CI.", type: "counter", samples: ciReworks.samples },
    { name: "bakery_cards", help: "Cards per lane.", type: "gauge", samples: cards.samples },
    { name: "bakery_active_runs", help: "Agent runs going now.", type: "gauge", samples: [{ labels: {}, value: live.runs }] },
    { name: "bakery_active_agent_reviews", help: "Agent reviews going now.", type: "gauge", samples: [{ labels: {}, value: live.reviews }] },
    { name: "bakery_active_pull_request_drafts", help: "Automatic pull requests being drafted or pushed now.", type: "gauge", samples: [{ labels: {}, value: live.pullRequests }] },
    { name: "bakery_active_run_started_seconds", help: "Start time, in Unix seconds, of each run, agent review and pull request draft going now.", type: "gauge",
      // Cut by code point, so an emoji at the limit is kept whole rather than split into a lone surrogate.
      samples: live.work.map(item => ({ labels: { repo: item.repo, card: item.cardId, title: Array.from(item.title).slice(0, 80).join(""), kind: item.kind }, value: item.startedAt / 1000 })) },
  ];
  return families.map(family => {
    const sampleName = family.type === "histogram" ? `${family.name}_bucket` : family.name;
    const lines = [`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`, ...family.samples.map(sample => `${sampleName}${labelText(sample.labels)} ${number(sample.value)}`)];
    if (family.type === "histogram") for (const row of durations.values()) lines.push(`${family.name}_sum${labelText(row.labels)} ${number(row.sum)}`, `${family.name}_count${labelText(row.labels)} ${row.count}`);
    return lines.join("\n");
  }).join("\n") + "\n";
}
