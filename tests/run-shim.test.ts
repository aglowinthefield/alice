import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Board } from "../server/board.js";
import { processStartTime, signalGroup } from "../server/platform.js";
import { runDir, Worker } from "../server/worker.js";

// Detached runs use process groups, which Windows lacks; there Pi still pipes into the server.
const skip = process.platform === "win32" ? "Windows keeps piped runs" : false;

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Condition not reached");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function alive(pid: number) {
  // PID 0 would mean this whole process group.
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
const firstTurn = [
  { type: "turn_start" },
  { type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage, content: [{ type: "text", text: "Looking." }] } },
  { type: "turn_end" },
];
const lastTurn = [
  { type: "message_end", message: { role: "assistant", stopReason: "stop", usage, content: [{ type: "text", text: "Done: all of it." }] } },
  { type: "agent_settled", aborted: false },
];
const lines = (events: object[]) => events.map(event => `${JSON.stringify(event)}\n`).join("");

/**
 * A repo and a fake Pi that records its PID, emits one turn, waits for `go-<card id>` (the worktree's name), then
 * emits a final report and settles. On SIGTERM it writes `term-<card id>` and exits only once `release-<card id>`
 * exists, like a Pi that takes a while to shut down.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-detached-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  const quote = (events: object[]) => events.map(event => `'${JSON.stringify(event)}'`).join(" ");
  writeFileSync(fakePi, `#!/bin/sh
card=$(basename "$PWD")
trap 'echo > "${dir}/term-$card"; until [ -e "${dir}/release-$card" ]; do sleep 0.05; done; exit 143' TERM
echo $$ > "${dir}/pid-$card"
printf '%s\\n' ${quote(firstTurn)}
until [ -e "${dir}/go-$card" ]; do sleep 0.05; done
printf '%s\\n' ${quote(lastTurn)}
echo finished > "${dir}/done-$card"
`);
  chmodSync(fakePi, 0o755);
  const piPid = (cardId: string) => existsSync(join(dir, `pid-${cardId}`)) ? Number(readFileSync(join(dir, `pid-${cardId}`), "utf8")) : 0;
  return {
    dir, repo, fakePi, piPid,
    go: (cardId: string) => writeFileSync(join(dir, `go-${cardId}`), ""),
    release: (cardId: string) => writeFileSync(join(dir, `release-${cardId}`), ""),
  };
}

test("a detached run writes Pi's output to its run directory and saves the applied offset with the transcript", { skip }, async () => {
  const f = fixture();
  const data = join(f.dir, "data");
  const board = new Board(join(f.dir, "board.sqlite")), worker = new Worker(board, data, f.fakePi);
  try {
    const card = board.createCard({ title: "Detached", body: "", repo: f.repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    const events = join(runDir(data, run.id), "events.jsonl");
    await waitFor(() => board.getRun(run.id)?.turns === 1);

    const running = board.getRun(run.id)!;
    assert.equal(readFileSync(events, "utf8"), lines(firstTurn), "Pi's stdout goes to the event file");
    assert.equal(running.eventsOffset, statSync(events).size, "every line read is applied and its offset saved");
    assert.equal(running.report, "Looking.");
    assert.ok(running.pid && running.pidStartedAt, "the shim's PID and start time are recorded");
    assert.equal(running.pidStartedAt, processStartTime(running.pid!));
    const pi = f.piPid(card.id);
    assert.notEqual(pi, running.pid, "the recorded PID is the shim, not Pi");
    assert.equal(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pi)], { encoding: "utf8" }).trim()), running.pid, "Pi runs in the shim's process group");

    f.go(card.id);
    await waitFor(() => board.getRun(run.id)?.status !== "running");
    const finished = board.getRun(run.id)!;
    assert.equal(finished.status, "review", finished.error ?? "");
    assert.equal(finished.report, "Done: all of it.");
    assert.equal(finished.turns, 1);
    assert.equal(finished.cost, 1);
    assert.equal(finished.eventsOffset, Buffer.byteLength(lines([...firstTurn, ...lastTurn])));
    assert.equal(existsSync(runDir(data, run.id)), false, "the run directory goes once the run is recorded");
  } finally {
    board.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a stop signals the shim's process group, so Pi's own children stop too", { skip }, async () => {
  const f = fixture();
  const data = join(f.dir, "data"), grandchild = join(f.dir, "grandchild");
  // Pi starts a long tool process, as a bash tool call would, and waits on it.
  writeFileSync(f.fakePi, `#!/bin/sh\nsleep 30 &\necho $! > "${grandchild}"\nwait\n`);
  const board = new Board(join(f.dir, "board.sqlite")), worker = new Worker(board, data, f.fakePi);
  try {
    const card = board.createCard({ title: "Stop", body: "", repo: f.repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => existsSync(grandchild) && readFileSync(grandchild, "utf8").trim() !== "");
    const tool = Number(readFileSync(grandchild, "utf8"));
    worker.stop(run.id);
    await waitFor(() => board.getRun(run.id)?.status === "failed");
    assert.match(board.getRun(run.id)!.error!, /Bakery sent SIGTERM: manual stop/);
    await waitFor(() => !alive(tool));
  } finally {
    board.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a reused PID is never signalled: the group signal needs the recorded start time", { skip }, () => {
  const started = processStartTime(process.pid);
  assert.ok(started, "this platform reports process start times");
  assert.equal(processStartTime(process.pid), started, "stable for one process");
  assert.equal(signalGroup(process.pid, `${started}-other`), false, "a different start time is a different process");
  assert.equal(processStartTime(2 ** 22 + 12345), null, "no such process");
});

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

test("killing the server mid-run does not stop Pi, and the next server stops a Pi it cannot follow", { skip }, async () => {
  const f = fixture();
  const home = join(f.dir, "home"), dataDir = join(f.dir, "data");
  mkdirSync(home);
  const children: ChildProcess[] = [], cards: string[] = [];
  const startServer = async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/api`;
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: dataDir, BAKERY_PORT: String(port), BAKERY_PI_BIN: f.fakePi, BAKERY_WT_BIN: join(f.dir, "no-wt") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });
    const request = async (path: string, method = "GET", input?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return response.json();
    };
    /** Resolves once the server answers HTTP, which is after its startup recovery. */
    const ready = async () => {
      const deadline = Date.now() + 20_000;
      while (true) {
        try { await fetch(`${url}/boards`); return; }
        catch {
          if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    };
    return { child, request, ready };
  };
  try {
    const first = await startServer();
    await first.ready();
    const boardId = (await first.request("/boards", "POST", { repo: f.repo })).id;
    for (const title of ["Survives", "Orphaned"]) {
      const card = await first.request(`/boards/${boardId}/cards`, "POST", { title, body: "" });
      await first.request(`/boards/${boardId}/cards/${card.id}/status`, "POST", { status: "ready" });
      await first.request(`/boards/${boardId}/cards/${card.id}/start`, "POST");
      cards.push(card.id);
    }
    const [survives, orphaned] = cards;
    await waitFor(() => cards.every(id => f.piPid(id) > 0));
    const runs = await Promise.all(cards.map(async id => (await first.request(`/boards/${boardId}/cards/${id}/runs`))[0]));
    const survivesDir = runDir(dataDir, runs[0].id);
    await waitFor(() => existsSync(join(survivesDir, "events.jsonl")) && statSync(join(survivesDir, "events.jsonl")).size > 0);

    const killed = new Promise(resolve => first.child.once("exit", resolve));
    first.child.kill("SIGKILL");
    await killed;
    assert.ok(alive(f.piPid(survives)) && alive(f.piPid(orphaned)), "Pi keeps running without the server");

    // The surviving run finishes on its own and its shim records how Pi exited.
    f.go(survives);
    await waitFor(() => existsSync(join(survivesDir, "exit.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(survivesDir, "exit.json"), "utf8")), { code: 0, signal: null });
    assert.equal(readFileSync(join(survivesDir, "events.jsonl"), "utf8"), lines([...firstTurn, ...lastTurn]));
    assert.equal(readFileSync(join(f.dir, `done-${survives}`), "utf8"), "finished\n");

    // Until a server can reattach, the next one stops a Pi still working in the card's worktree (PID and start time
    // match). It waits for that Pi to exit before marking the run interrupted, clearing its files or serving requests.
    const second = await startServer();
    await waitFor(() => existsSync(join(f.dir, `term-${orphaned}`)), 20_000);
    const db = new DatabaseSync(join(dataDir, "bakery.sqlite"), { readOnly: true });
    try { assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(runs[1].id) as { status: string }).status, "running", "not interrupted while its Pi is still exiting"); }
    finally { db.close(); }
    assert.ok(existsSync(runDir(dataDir, runs[1].id)), "its files stay while Pi is still exiting");
    assert.ok(alive(f.piPid(orphaned)));
    f.release(orphaned);
    await second.ready();
    assert.equal(alive(f.piPid(orphaned)), false);
    for (const id of cards) assert.equal((await second.request(`/boards/${boardId}/cards/${id}/runs`))[0].status, "interrupted");
    for (const run of runs) assert.equal(existsSync(runDir(dataDir, run.id)), false, "the old runs' directories are cleared");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    // A fake Pi left waiting for its go file would wait forever once the directory is gone.
    for (const id of cards) if (alive(f.piPid(id))) process.kill(f.piPid(id), "SIGKILL");
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a shim whose worker dies before saving its PID exits without starting Pi", { skip }, async () => {
  const f = fixture();
  const script = join(f.dir, "worker.ts"), shimPid = join(f.dir, "shim-pid");
  try {
    // A server process that dies in the middle of `attach`, before it could acknowledge the shim.
    writeFileSync(script, `import { writeFileSync } from "node:fs";
import { Board } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "board.ts")).href)};
import { Worker } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "worker.ts")).href)};
const board = new Board(${JSON.stringify(join(f.dir, "board.sqlite"))});
board.attach = (_id: string, pid: number) => { writeFileSync(${JSON.stringify(shimPid)}, String(pid)); process.kill(process.pid, "SIGKILL"); };
const card = board.createCard({ title: "Dies", body: "", repo: ${JSON.stringify(f.repo)} });
board.setStatus(card.id, "ready");
new Worker(board, ${JSON.stringify(join(f.dir, "data"))}, ${JSON.stringify(f.fakePi)}).start(board.getCard(card.id)!);
`);
    const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), stdio: "ignore" });
    const [, signal] = await new Promise<[number | null, string | null]>(resolve => child.once("exit", (code, sig) => resolve([code, sig])));
    assert.equal(signal, "SIGKILL");
    const shim = Number(readFileSync(shimPid, "utf8"));
    await waitFor(() => !alive(shim));
    assert.deepEqual(readdirSync(f.dir).filter(name => name.startsWith("pid-")), [], "Pi never started");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a stop that reaches the shim before Pi starts keeps Pi from starting", { skip }, async () => {
  const f = fixture();
  const dir = join(f.dir, "run");
  mkdirSync(dir);
  try {
    const shim = spawn(process.execPath, [join(process.cwd(), "server", "run-shim.ts"), dir, f.fakePi], { cwd: f.repo, detached: true, stdio: ["pipe", "pipe", "inherit"] });
    let said = "";
    shim.stdout!.on("data", chunk => { said += chunk.toString(); });
    const exited = new Promise(resolve => shim.once("exit", resolve));
    await waitFor(() => said.includes("ready\n"));
    // The signal handlers are installed, the worker has not said start yet: a group stop now must not be dropped.
    process.kill(-shim.pid!, "SIGTERM");
    await waitFor(() => said.includes("stopping\n"));
    shim.stdin!.end("start\n");
    await exited;
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")), { code: null, signal: "SIGTERM", started: false });
    assert.deepEqual(readdirSync(f.dir).filter(name => name.startsWith("pid-")), [], "Pi never started");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failed write rolls back the whole batch and its offset, and stops the run", { skip }, async () => {
  const f = fixture();
  const script = join(f.dir, "pi-fake.mjs");
  const batch = [
    { type: "message_start", message: { role: "assistant", provider: "anthropic", model: "claude" } },
    { type: "turn_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checked the layout." } },
    { type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage, content: [{ type: "text", text: "Checked the layout." }] } },
    { type: "turn_end" },
  ];
  // One write, so the worker reads the whole batch at once; then Pi keeps working until it is stopped.
  writeFileSync(script, `process.stdout.write(${JSON.stringify(lines(batch))}); setInterval(() => {}, 1000);\n`);
  writeFileSync(f.fakePi, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  const board = new Board(join(f.dir, "board.sqlite")), worker = new Worker(board, join(f.dir, "data"), f.fakePi);
  try {
    board.recordUsage = () => { throw new Error("disk I/O error"); };
    const card = board.createCard({ title: "Write fails", body: "", repo: f.repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status !== "running");
    const failed = board.getRun(run.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /Bakery sent SIGTERM: Bakery could not save the run's events/);
    assert.match(failed.error!, /Bakery could not save Pi's events: disk I\/O error/);
    assert.equal(failed.eventsOffset, 0, "the offset did not move past the failed batch");
    assert.equal(failed.turns, 0);
    assert.equal(failed.agent, "");
    assert.equal(failed.report, null);
    assert.doesNotMatch(failed.output, /Checked the layout/);
  } finally {
    board.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("another Unix pipes Pi into the server, with no run directory or event offset", { skip }, async () => {
  const f = fixture();
  const data = join(f.dir, "data");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const board = new Board(join(f.dir, "board.sqlite")), worker = new Worker(board, data, f.fakePi);
  try {
    // Without start times (processStartTime is null there) a detached run could never be stopped safely.
    Object.defineProperty(process, "platform", { value: "freebsd" });
    const card = board.createCard({ title: "Piped", body: "", repo: f.repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    Object.defineProperty(process, "platform", platform);
    await waitFor(() => board.getRun(run.id)?.turns === 1);
    assert.equal(existsSync(runDir(data, run.id)), false);
    f.go(card.id);
    await waitFor(() => board.getRun(run.id)?.status !== "running");
    const finished = board.getRun(run.id)!;
    assert.equal(finished.status, "review", finished.error ?? "");
    assert.equal(finished.report, "Done: all of it.");
    assert.equal(finished.eventsOffset, 0);
    assert.equal(finished.pidStartedAt, null);
  } finally {
    Object.defineProperty(process, "platform", platform);
    board.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
