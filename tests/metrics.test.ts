import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { renderMetrics, type ActiveWork, type Live } from "../server/metrics.js";
import { parseTime, type StatsRun } from "../server/stats.js";
import { Worker } from "../server/worker.js";

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
    closes: [],
  }, live({ runs: 1, pullRequests: 2, work: [going({ kind: "pr_draft", cardId: "c2" })] }), "1.2.3");

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
  assert.equal(sample(text, "alice_active_agent_reviews"), 0);
  assert.equal(sample(text, "alice_active_pull_request_drafts"), 2);
  assert.equal(sample(text, 'alice_active_run_started_seconds{repo="/code/app",card="c2",title="Ship it",kind="pr_draft"}'), 1_767_261_600);
});

const going = (overrides: Partial<ActiveWork>): ActiveWork => ({ kind: "run", repo: "/code/app", cardId: "c1", title: "Ship it", startedAt: Date.parse("2026-01-01T10:00:00Z"), ...overrides });
const live = (overrides: Partial<Live>): Live => ({ runs: 0, reviews: 0, pullRequests: 0, work: [], ...overrides });
/** The Running now series in a scrape: each one's labels as written, and its value. */
const runningNow = (text: string) => text.split("\n").filter(line => line.startsWith("alice_active_run_started_seconds{"))
  .map(line => { const end = line.lastIndexOf("} "); return { labels: line.slice("alice_active_run_started_seconds{".length, end), value: Number(line.slice(end + 2)) }; });
/** A repository path as it appears in a label value: backslashes (Windows paths) are escaped. */
const repoLabel = (path: string) => path.replace(/\\/g, "\\\\");

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * A fake Pi written in JavaScript, so it runs on every platform: an npm-style `.cmd` shim on Windows, which Alice
 * runs under node (server/platform.ts), and a shell wrapper elsewhere. `body` runs with these helpers: `until(file)`
 * waits for a gate file, `emit(...events)` prints Pi's JSON events and `settled` is the event that ends a clean run.
 */
function fakePi(dir: string, name: string, body: string) {
  const script = join(dir, `${name}.mjs`), bin = join(dir, name);
  writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const until = async file => { while (!existsSync(file)) await new Promise(resolve => setTimeout(resolve, 20)); };
const emit = (...events) => { for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n"); };
const settled = { type: "agent_settled", aborted: false };
${body}
`);
  if (process.platform === "win32") writeFileSync(`${bin}.cmd`, `@"%~dp0\\${name}.mjs" %*\r\n`);
  else { writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); chmodSync(bin, 0o755); }
  return bin;
}
/** Fake Pi code for a card run: a change in the worktree, then a clean finish. */
const workBody = `appendFileSync("feature.txt", "feature\\n"); emit(settled);`;
/** Whether a process is still running. */
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A repository with one commit on main, pushed to a local bare origin. */
function gitRepo(dir: string, files: Record<string, string>) {
  const repo = join(dir, "repo"), origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", repo, "push", "-q", "-u", "origin", "main"]);
  return repo;
}

/** A Alice data directory in `home` whose board holds one card that has reached Review, run by `pi` in this process. */
async function reviewCard(home: string, repo: string, pi: string, setUp: (board: Board, boardId: string) => void) {
  const data = join(home, "data");
  mkdirSync(data);
  const board = new Board(join(data, "alice.sqlite"));
  try {
    const repoBoard = board.addRepo(repo);
    setUp(board, repoBoard.id);
    const card = board.createCard({ title: "Add the feature file", body: "", repo });
    board.setStatus(card.id, "ready");
    const worker = new Worker(board, data, pi);
    const run = worker.start(board.getCard(card.id)!);
    await worker.drain();
    assert.equal(board.getRun(run.id)?.status, "review", board.getRun(run.id)?.error ?? "");
    return { boardId: repoBoard.id, cardId: card.id };
  } finally { board.close(); }
}

test("a title is cut to 80 code points, keeping an emoji at the limit whole", () => {
  const title = `${"a".repeat(79)}🐈 and the rest is left out`;
  const text = renderMetrics({ runs: [], reviews: [], cards: [], closes: [] }, live({ work: [going({ title })] }), "1");
  assert.deepEqual(runningNow(text), [{ labels: `repo="/code/app",card="c1",title="${"a".repeat(79)}🐈",kind="run"`, value: 1_767_261_600 }]);
});

test("a run going now has one Running now series, gone once the run finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-metrics-run-"));
  const gate = join(dir, "gate");
  const repo = gitRepo(dir, { "README.md": "fixture\n" });
  // Pi stays running until the test opens the gate, then settles cleanly.
  const pi = fakePi(dir, "pi-fake", `await until(${JSON.stringify(gate)}); emit({ type: "turn_start" }, { type: "turn_end", message: { stopReason: "stop" } }, settled);`);
  const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), pi);
  try {
    const title = "Show what Alice is running in Grafana's Running now table, one row per run, review and draft";
    const card = board.createCard({ title, body: "", repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    const series = () => runningNow(renderMetrics(board.statsInput(), live({ runs: worker.activeCount, work: board.runsGoingNow(worker.activeRunIds) }), "1"));

    assert.deepEqual(series(), [{ labels: `repo="${repoLabel(repo)}",card="${card.id}",title="${title.slice(0, 80)}",kind="run"`, value: parseTime(run.startedAt)! / 1000 }]);
    writeFileSync(gate, "");
    await waitFor(() => worker.activeCount === 0);
    assert.equal(board.getRun(run.id)?.status, "review", board.getRun(run.id)?.error ?? "");
    assert.deepEqual(series(), []);
  } finally {
    // Let Pi exit before its directory goes, even when an assertion failed.
    writeFileSync(gate, "");
    await worker.drain();
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("label values are escaped", () => {
  const text = renderMetrics({ runs: [], reviews: [], cards: [{ repo: 'C:\\code\\"odd"\nrepo', status: "ready", createdAt: "", updatedAt: "", attempts: 0, reviewRounds: 0, ciReworks: 0 }], closes: [] }, live({}), "1");
  assert.equal(sample(text, 'alice_cards{repo="C:\\\\code\\\\\\"odd\\"\\nrepo",status="ready"}'), 1);
});

async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

/** Starts Alice's server on a free port with its data in `home`, and resolves once it answers. */
async function startServer(home: string, env: Record<string, string>) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ALICE_HOST: "", ALICE_ALLOWED_HOSTS: "", HOME: home, ALICE_DATA_DIR: join(home, "data"), ALICE_PORT: String(port), ...env },
  });
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const deadline = Date.now() + 8000;
  while (true) {
    try { await fetch(url("/api/boards")); break; }
    catch { if (Date.now() > deadline || child.exitCode !== null) throw new Error("server did not start"); await new Promise(r => setTimeout(r, 25)); }
  }
  const stop = () => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once("close", () => resolve()); child.kill("SIGTERM"); });
  return { url, stop, metrics: async () => (await fetch(url("/metrics"))).text() };
}

test("the server serves /metrics only with ALICE_METRICS=1", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-metrics-api-"));
  try {
    let server = await startServer(home, { ALICE_METRICS: "" });
    assert.equal((await fetch(server.url("/metrics"))).status, 404);
    await server.stop();

    server = await startServer(home, { ALICE_METRICS: "1" });
    const response = await fetch(server.url("/metrics"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const text = await response.text();
    assert.match(text, /^alice_info\{version="[^"]+"\} 1$/m);
    assert.equal(sample(text, "alice_active_runs"), 0);
    await server.stop();
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("/metrics lists one pull request draft per card: a newer attempt reaching Review replaces the draft still being written", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-metrics-draft-"));
  const gate = join(home, "gate"), drafters = join(home, "drafters");
  // A PR template makes Alice ask Pi for the draft instead of using the card text.
  const repo = gitRepo(home, { "README.md": "fixture\n", ".github/pull_request_template.md": "Summary\n" });
  const reply = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ title: "Add the feature file", body: "Summary\n\nAdds feature.txt." }) }] } };
  // One Pi for the server: the drafter (the only call without tools) records its pid and waits for the gate; card runs finish at once.
  const pi = fakePi(home, "pi-fake", `if (process.argv.includes("--no-tools")) { appendFileSync(${JSON.stringify(drafters)}, process.pid + "\\n"); await until(${JSON.stringify(gate)}); emit(${JSON.stringify(reply)}, settled); } else { ${workBody} }`);
  const pids = () => (existsSync(drafters) ? readFileSync(drafters, "utf8") : "").split("\n").filter(Boolean).map(Number);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    // A manual-approval github-pr board: no auto-review and no automatic pull requests.
    const { boardId, cardId } = await reviewCard(home, repo, pi, (board, id) => { board.setRemoteUrl(id, "https://github.com/acme/widgets"); board.setIntegration(id, "github-pr"); });
    const labels = `repo="${repoLabel(repo)}",card="${cardId}",title="Add the feature file",kind="pr_draft"`;

    // The server prepares the Review card at startup, and the drafter holds that draft open.
    const startedAfter = Date.now() / 1000;
    server = await startServer(home, { ALICE_METRICS: "1", ALICE_PI_BIN: pi });
    const series = async () => runningNow(await server!.metrics());
    await waitFor(async () => (await series()).length > 0);
    const [first] = await series();
    assert.equal(first.labels, labels);
    assert.ok(first.value >= startedAfter && first.value <= Date.now() / 1000, `start time ${first.value} is not during this test`);

    // A second attempt reaches Review while the first draft is still open, and its own draft starts.
    assert.equal((await fetch(server.url(`/api/boards/${boardId}/cards/${cardId}/start`), { method: "POST" })).status, 202);
    await waitFor(() => pids().length === 2);
    // The superseded drafter is stopped, not left running beside the new one.
    await waitFor(() => !alive(pids()[0]));
    const text = await server.metrics();
    assert.deepEqual(runningNow(text).map(item => item.labels), [labels]);
    assert.ok(runningNow(text)[0].value >= first.value);
    // The count of automatic pull requests is unchanged: this draft is for a person's Approve.
    assert.equal(sample(text, "alice_active_pull_request_drafts"), 0);

    writeFileSync(gate, "");
    await waitFor(async () => (await series()).length === 0);
  } finally {
    // Release the drafter before stopping the server, so nothing still runs in the directory being removed.
    writeFileSync(gate, "");
    await server?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("/metrics lists an agent review while it runs, and drops it once the review settles", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-metrics-review-"));
  const gate = join(home, "gate");
  const repo = gitRepo(home, { "README.md": "fixture\n" });
  // The reviewer (a --print call) waits for the gate and gives no verdict, so the review settles as needing a person.
  const pi = fakePi(home, "pi-fake", `if (process.argv.includes("--print")) { await until(${JSON.stringify(gate)}); emit(settled); } else { ${workBody} }`);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const { cardId } = await reviewCard(home, repo, pi, (board, id) => board.setAutoReview(id, true));
    const startedAfter = Date.now() / 1000;
    server = await startServer(home, { ALICE_METRICS: "1", ALICE_PI_BIN: pi });
    const series = async () => runningNow(await server!.metrics());
    await waitFor(async () => (await series()).length > 0);
    const text = await server.metrics();
    assert.deepEqual(runningNow(text).map(item => item.labels), [`repo="${repoLabel(repo)}",card="${cardId}",title="Add the feature file",kind="agent_review"`]);
    const [review] = runningNow(text);
    assert.ok(review.value >= startedAfter && review.value <= Date.now() / 1000, `start time ${review.value} is not during this test`);
    assert.equal(sample(text, "alice_active_agent_reviews"), 1);

    writeFileSync(gate, "");
    await waitFor(async () => (await series()).length === 0);
    assert.equal(sample(await server.metrics(), "alice_active_agent_reviews"), 0);
  } finally {
    writeFileSync(gate, "");
    await server?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
