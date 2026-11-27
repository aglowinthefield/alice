// Why a run happened, so a card's cost can be split into its first attempt and the rework after it.
import type { RunKind } from "../shared/wire.js";
export type { RunKind };

export const runKindLabels: Record<RunKind, string> = {
  first: "First attempt",
  send_back: "Reviewer send-back",
  ci_fix: "CI or hook fix",
  retry: "Retry after failure",
  rerun: "Manual rerun",
};

export const runKindOrder: RunKind[] = [
  "first",
  "send_back",
  "ci_fix",
  "retry",
  "rerun",
];

type RunFacts = {
  id: string;
  attempt: number;
  status: string;
  recoveryOf?: string | null;
  /** Server runs only: 1 for a CI fix, 2 for a conflict repair. */
  ciFix?: number;
};
type EventFacts = { toStatus: string | null; reason: string };

/**
 * Classifies one run from the "Attempt N started …" line Alice records when it starts a run (see the `why` callers
 * of `worker.start`), the operator's requested review comments on the run before it, and the run fields.
 * Older runs without a recorded start line fall back to the run fields alone.
 */
export function classifyRun(
  run: RunFacts,
  previous: RunFacts | undefined,
  startReason: string,
  previousHadRequestedChanges: boolean,
): RunKind {
  if (run.attempt <= 1 || !previous) return "first";
  if (
    /agent reviewer's requested changes|changes requested on the pull request/.test(
      startReason,
    )
  )
    return "send_back";
  if (/to fix failing CI|to fix the failing /.test(startReason))
    return "ci_fix";
  if (run.recoveryOf || /in a fresh session/.test(startReason)) return "retry";
  if (run.ciFix) return "ci_fix";
  if (previousHadRequestedChanges) return "send_back";
  if (previous.status === "failed" || previous.status === "interrupted")
    return "retry";
  return "rerun";
}

/** Each run's kind, by run id. `requestedRunIds` are runs the operator requested changes on. */
export function classifyRuns(
  runs: RunFacts[],
  events: EventFacts[],
  requestedRunIds: ReadonlySet<string>,
): Map<string, RunKind> {
  const starts = new Map<number, string>();
  for (const event of events) {
    const match =
      event.toStatus === "running" &&
      /^Attempt (\d+) started/.exec(event.reason);
    if (match) starts.set(Number(match[1]), event.reason);
  }
  const ordered = [...runs].sort((a, b) => a.attempt - b.attempt);
  return new Map(
    ordered.map((run, index) => {
      const previous = index > 0 ? ordered[index - 1] : undefined;
      return [
        run.id,
        classifyRun(
          run,
          previous,
          starts.get(run.attempt) ?? "",
          !!previous && requestedRunIds.has(previous.id),
        ),
      ];
    }),
  );
}

export type CostSplit = {
  /** Spend per run kind, only for kinds that have runs. Null cost means none of that kind's runs recorded usage. */
  kinds: { kind: RunKind; cost: number | null; runs: number }[];
  /** Agent reviews on the card, which are neither first attempt nor rework. */
  reviews: number | null;
};

/** Sums runs by kind; with `reviews` the parts add up to the card total. */
export function costByKind(
  runs: { kind?: RunKind; cost?: number | null }[],
  reviews: { cost?: number | null }[] = [],
): CostSplit {
  const totals = new Map<RunKind, { cost: number | null; runs: number }>();
  for (const run of runs) {
    const kind = run.kind ?? "first";
    const entry = totals.get(kind) ?? { cost: null, runs: 0 };
    entry.runs += 1;
    if (typeof run.cost === "number") entry.cost = (entry.cost ?? 0) + run.cost;
    totals.set(kind, entry);
  }
  const reviewCosts = reviews
    .map((review) => review.cost)
    .filter((cost): cost is number => typeof cost === "number");
  return {
    kinds: runKindOrder
      .filter((kind) => totals.has(kind))
      .map((kind) => ({ kind, ...totals.get(kind)! })),
    reviews: reviewCosts.length
      ? reviewCosts.reduce((sum, cost) => sum + cost, 0)
      : null,
  };
}

/** Rework (every run after the first attempt) over half of what the card cost. */
export const reworkHeavy = (card: {
  cost?: number | null;
  reworkCost?: number | null;
}) =>
  typeof card.cost === "number" &&
  card.cost > 0 &&
  typeof card.reworkCost === "number" &&
  card.reworkCost > card.cost / 2;
