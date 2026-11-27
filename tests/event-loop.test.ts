import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { EventLoopDelay, renderMetrics } from "../server/metrics.js";
import { fakeGit, waitFor } from "./fake-git.js";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

// The fake git holds `rev-parse --show-toplevel` in the marker repository until the test releases it, so the server
// has a Git call pending for as long as the test wants. Everything else runs real Git.
test("a slow git call does not stop /api/status or /metrics from answering, and overlapping probes share it", { skip: process.platform === "win32" && "the fake git is a shell script" }, async () => {
  // Canonical, as the handler passes it to Git: under a symlinked TMPDIR the fake would otherwise never match.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bakery-slow-git-")));
  const slowRepo = join(dir, "slow-repo");
  mkdirSync(slowRepo); mkdirSync(join(dir, "home"));
  execFileSync("git", ["init", "-q", "-b", "main", slowRepo]);
  const fake = fakeGit(dir, [{ name: "root", match: `${slowRepo} rev-parse --show-toplevel` }]);
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${fake.bin}${delimiter}${process.env.PATH}`, HOME: join(dir, "home"), BAKERY_DATA_DIR: join(dir, "data"), BAKERY_PORT: String(port), BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", BAKERY_GH_BIN: "false", BAKERY_METRICS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr?.on("data", chunk => { log += chunk; });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited: ${log.slice(-4000)}`);
      try { return (await fetch(`${url}/api/status`)).ok; } catch { return false; }
    }, "the server to listen");

    const settled: boolean[] = [];
    // Resolves `sent` once the request is written to the socket, and `answer` with the response.
    const probe = (index: number) => {
      settled[index] = false;
      let sent!: () => void;
      const written = new Promise<void>(resolve => { sent = resolve; });
      const answer = new Promise<{ status: number; body: { root?: string } }>((resolve, reject) => {
        const request = httpGet(`${url}/api/repository-root?path=${encodeURIComponent(slowRepo)}`, response => {
          let text = "";
          response.on("data", chunk => { text += chunk; });
          response.on("end", () => { settled[index] = true; resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }); });
        });
        request.on("finish", sent);
        request.on("error", reject);
      });
      return { written, answer };
    };
    const first = probe(0);
    await waitFor(() => fake.waiting("root"), "the server to call the slow git");
    // A second request for the same directory while the first probe is still held.
    const second = probe(1);
    await second.written;

    // The git call is still blocked on the release file, and the server answers anyway. /api/status is asked after
    // the second request was sent, so the server has read that request by the time it answers.
    const status = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(status.status, 200);
    assert.equal(typeof (await status.json()).hostname, "string");
    const metrics = await (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(30_000) })).text();
    assert.match(metrics, /^bakery_event_loop_delay_seconds\{stat="p99"\} \d/m);
    assert.deepEqual(settled, [false, false], "both requests are still waiting on git");

    fake.release("root");
    for (const answered of await Promise.all([first.answer, second.answer])) {
      assert.equal(answered.status, 200);
      assert.equal(answered.body.root, slowRepo);
    }
    // Every Git a request started has run by the time it answers, so this count is final.
    assert.equal(fake.count("root"), 1, "the overlapping requests shared one probe");
  } finally {
    fake.releaseAll();
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event-loop delay renders as p50, p99 and max in seconds, and a read starts a new window", async () => {
  const delay = new EventLoopDelay();
  try {
    await new Promise(resolve => setImmediate(resolve));
    const first = delay.read();
    assert.ok([first.p50, first.p99, first.max].every(value => Number.isFinite(value) && value >= 0), JSON.stringify(first));
    // Nothing has been sampled since the read above reset the window.
    assert.deepEqual(delay.read(false), { p50: 0, p99: 0, max: 0 });
  } finally { delay.stop(); }
  const text = renderMetrics({ runs: [], reviews: [], cards: [] }, { runs: 0, reviews: 0, pullRequests: 0 }, "1", { p50: 0.001, p99: 0.25, max: 1.5 });
  assert.match(text, /# TYPE bakery_event_loop_delay_seconds gauge/);
  assert.match(text, /^bakery_event_loop_delay_seconds\{stat="p50"\} 0\.001$/m);
  assert.match(text, /^bakery_event_loop_delay_seconds\{stat="p99"\} 0\.25$/m);
  assert.match(text, /^bakery_event_loop_delay_seconds\{stat="max"\} 1\.5$/m);
  assert.doesNotMatch(renderMetrics({ runs: [], reviews: [], cards: [] }, { runs: 0, reviews: 0, pullRequests: 0 }, "1"), /event_loop/);
});
