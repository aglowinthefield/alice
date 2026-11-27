import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMetrics } from "../server/metrics.js";
import type { StatsRun } from "../server/stats.js";

const run = (overrides: Partial<StatsRun>): StatsRun => ({
  repo: "/code/app", cardId: "c1", status: "review", startedBy: "operator", agent: "anthropic/opus", ciFix: 0,
  startedAt: "2026-01-01 10:00:00", finishedAt: "2026-01-01 10:04:00", cost: 1.5, inputTokens: 100, outputTokens: 20,
  cacheReadTokens: 300, cacheWriteTokens: 5, cacheTasks: 4, cacheHits: 3, cacheSavedMs: 90_000, ...overrides,
});

/** The value of one sample line, found by its exact name and labels. */
const sample = (text: string, series: string) => {
  const line = text.split("\n").find(item => item.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

test("finished runs become counters and a duration histogram; running ones wait until they finish", () => {
  const text = renderMetrics({
    runs: [run({}), run({ cardId: "c2", cost: 0.5, finishedAt: "2026-01-01 10:20:00" }), run({ status: "failed", agent: "", cost: null }), run({ status: "running", finishedAt: null, cost: 9 })],
    reviews: [{ repo: "/code/app", state: "merged", agent: "x", startedAt: "2026-01-01 11:00:00", finishedAt: "2026-01-01 11:01:00", cost: 0.25 }, { repo: "/code/app", state: "running", agent: "x", startedAt: "2026-01-01 11:00:00", finishedAt: null, cost: 7 }],
    cards: [{ repo: "/code/app", status: "ready", createdAt: "", updatedAt: "", attempts: 1, reviewRounds: 2, ciReworks: 1 }, { repo: "/code/app", status: "ready", createdAt: "", updatedAt: "", attempts: 0, reviewRounds: 0, ciReworks: 0 }],
  }, { runs: 1, reviews: 0, pullRequests: 2 }, "1.2.3");

  assert.equal(sample(text, 'alice_info{version="1.2.3"}'), 1);
  assert.equal(sample(text, 'alice_runs_total{repo="/code/app",agent="anthropic/opus",status="review",started_by="operator"}'), 2);
  assert.equal(sample(text, 'alice_runs_total{repo="/code/app",agent="unknown",status="failed",started_by="operator"}'), 1);
  assert.equal(text.includes('status="running"'), false);
  assert.equal(sample(text, 'alice_run_cost_dollars_total{repo="/code/app",agent="anthropic/opus"}'), 2);
  assert.equal(sample(text, 'alice_run_tokens_total{repo="/code/app",agent="anthropic/opus",type="cache_read"}'), 600);
  assert.equal(sample(text, 'alice_build_cache_saved_seconds_total{repo="/code/app"}'), 270);
  // 4 and 20 minutes: the 5 minute bucket holds one, the 30 minute bucket both.
  assert.equal(sample(text, 'alice_run_duration_seconds_bucket{repo="/code/app",agent="anthropic/opus",status="review",le="300"}'), 1);
  assert.equal(sample(text, 'alice_run_duration_seconds_bucket{repo="/code/app",agent="anthropic/opus",status="review",le="1800"}'), 2);
  assert.equal(sample(text, 'alice_run_duration_seconds_bucket{repo="/code/app",agent="anthropic/opus",status="review",le="+Inf"}'), 2);
  assert.equal(sample(text, 'alice_run_duration_seconds_sum{repo="/code/app",agent="anthropic/opus",status="review"}'), 1440);
  assert.equal(sample(text, 'alice_run_duration_seconds_count{repo="/code/app",agent="anthropic/opus",status="review"}'), 2);
  assert.equal(sample(text, 'alice_agent_reviews_total{repo="/code/app",state="merged"}'), 1);
  assert.equal(sample(text, 'alice_agent_review_cost_dollars_total{repo="/code/app"}'), 0.25);
  assert.equal(sample(text, 'alice_cards{repo="/code/app",status="ready"}'), 2);
  assert.equal(sample(text, 'alice_card_review_rounds_total{repo="/code/app"}'), 2);
  assert.equal(sample(text, "alice_active_runs"), 1);
  assert.equal(sample(text, "alice_active_pull_request_drafts"), 2);
});

test("label values are escaped", () => {
  const text = renderMetrics({ runs: [], reviews: [], cards: [{ repo: 'C:\\code\\"odd"\nrepo', status: "ready", createdAt: "", updatedAt: "", attempts: 0, reviewRounds: 0, ciReworks: 0 }] }, { runs: 0, reviews: 0, pullRequests: 0 }, "1");
  assert.equal(sample(text, 'alice_cards{repo="C:\\\\code\\\\\\"odd\\"\\nrepo",status="ready"}'), 1);
});

async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

test("the server serves /metrics only with ALICE_METRICS=1", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-metrics-api-"));
  const port = await freePort();
  const start = (metrics: string) => spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ALICE_HOST: "", ALICE_ALLOWED_HOSTS: "", HOME: home, ALICE_DATA_DIR: join(home, "data"), ALICE_PORT: String(port), ALICE_METRICS: metrics },
  });
  const up = async (child: ReturnType<typeof start>) => { const deadline = Date.now() + 8000; while (true) { try { await fetch(`http://127.0.0.1:${port}/api/boards`); return; } catch { if (Date.now() > deadline || child.exitCode !== null) throw new Error("server did not start"); await new Promise(r => setTimeout(r, 25)); } } };
  const stop = (child: ReturnType<typeof start>) => new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGTERM"); });
  try {
    let child = start(""); await up(child);
    assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`)).status, 404);
    await stop(child);

    child = start("1"); await up(child);
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const text = await response.text();
    assert.match(text, /^alice_info\{version="[^"]+"\} 1$/m);
    assert.equal(sample(text, "alice_active_runs"), 0);
    await stop(child);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
