import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import childProcess, { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";
import { Chats } from "../server/chat.js";
import { chatImagePath } from "../server/chat-images.js";
import { discuss } from "../server/discuss.js";
import { runTempDir, spawnPi, sweepRunTemp } from "../server/run-temp.js";

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The fake Pi makes a scratch directory the way any tool would, and says where it landed.
const mktemp = (seen: string) => `d=$(mktemp -d) && echo marker > "$d/file" && printf '%s' "$d" > "${seen}"`;
const settled = `printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"done"}]}}' '{"type":"agent_settled","aborted":false}'`;

function repoFixture() {
  const dir = mkdtempSync(join(tmpdir(), "alice-run-temp-")), repo = join(dir, "repo"), fakePi = join(dir, "pi-fake"), seen = join(dir, "seen");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  const board = new Board(join(dir, "board.sqlite"));
  const pi = (body: string) => { writeFileSync(fakePi, `#!/bin/sh\n${body}\n`); chmodSync(fakePi, 0o755); rmSync(seen, { force: true }); };
  return { dir, repo, fakePi, seen, board, pi, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a card run's scratch lands in its own TMPDIR, which is removed when the run succeeds, fails or is stopped", async () => {
  const f = repoFixture();
  try {
    const worker = new Worker(f.board, join(f.dir, "data"), f.fakePi);
    const card = f.board.createCard({ title: "Scratch", body: "", repo: f.repo });
    f.board.setStatus(card.id, "ready");
    const run = async (body: string, status: "review" | "failed", stop = false) => {
      f.pi(body);
      const started = worker.start(f.board.getCard(card.id)!);
      if (stop) {
        await waitFor(() => existsSync(f.seen));
        assert.ok(existsSync(join(readFileSync(f.seen, "utf8"), "file")), "the scratch exists while the run is alive");
        worker.stop(started.id);
      }
      await waitFor(() => f.board.getRun(started.id)?.status === status);
      const scratch = readFileSync(f.seen, "utf8");
      assert.equal(dirname(scratch), runTempDir(started.id), "mktemp -d landed under the run's own directory");
      await waitFor(() => !existsSync(runTempDir(started.id)));
    };
    await run(`${mktemp(f.seen)}\n${settled}`, "review");
    await run(`${mktemp(f.seen)}\nexit 1`, "failed");
    await run(`${mktemp(f.seen)}\nexec sleep 30`, "failed", true);
    assert.match(f.board.listRuns(card.id)[0].error!, /Alice sent SIGTERM: manual stop/);
  } finally { f.close(); }
});

test("a chat turn's screenshot under TMPDIR is published before the directory goes, and a discussion gets its own directory", async () => {
  const f = repoFixture();
  try {
    const shot = "\\211PNG\\r\\n\\032\\n0000";
    f.pi(`${mktemp(f.seen)}
printf '${shot}' > "$TMPDIR/shot.png"
echo "{\\"type\\":\\"message_update\\",\\"assistantMessageEvent\\":{\\"type\\":\\"text_delta\\",\\"delta\\":\\"See ![shot]($TMPDIR/shot.png)\\"}}"
${settled}`);
    const repoBoard = f.board.addRepo(f.repo), sessionDir = join(f.dir, "sessions");
    const chats = new Chats(f.board, { piBin: f.fakePi, sessionDir, cli: "cli", env: process.env });
    const chat = f.board.createChat(repoBoard.id);
    const finished = new Promise<void>(resolve => { const off = chats.subscribe(chat.id, event => { if (event.type === "live" && event.live === null) { off(); resolve(); } }); });
    chats.send(repoBoard, chat.id, "hello");
    await finished;
    const turnDir = dirname(readFileSync(f.seen, "utf8"));
    assert.match(turnDir, /[\\/]alice-run-[0-9a-f-]{36}$/);
    const reply = f.board.listChatMessages(chat.id).find(message => message.role === "agent")!;
    const image = /\/images\/([0-9a-f]{64})\)/.exec(reply.parts.map(part => part.type === "text" ? part.text : "").join(""));
    assert.ok(image, `the screenshot link was published: ${JSON.stringify(reply.parts)}`);
    await waitFor(() => !existsSync(turnDir));
    assert.ok(existsSync(chatImagePath(sessionDir, chat.id, image[1])), "the published copy outlives the turn's directory");

    f.pi(`${mktemp(f.seen)}\nexit 2`);
    await assert.rejects(discuss({ prompt: "why?", cwd: f.repo, piBin: f.fakePi, models: [] }), /Pi failed \(2\)/);
    const discussDir = dirname(readFileSync(f.seen, "utf8"));
    assert.notEqual(discussDir, turnDir, "every Pi process gets a fresh directory");
    await waitFor(() => !existsSync(discussDir));
  } finally { f.close(); }
});

test("when a tool process Pi left behind holds stdout open, Alice closes the pipes so 'close' fires and the TMPDIR goes", async () => {
  const f = repoFixture();
  const leftover = join(f.dir, "leftover.pid"), id = randomUUID();
  try {
    const child = spawnPi(id, "/bin/sh", ["-c", `sleep 30 & echo $! > '${leftover}'; exit 0`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise(resolve => child.once("close", resolve));
    await waitFor(() => !existsSync(runTempDir(id)));
    assert.ok(alive(Number(readFileSync(leftover, "utf8"))), "the leftover still held the pipe; Alice did not wait for it");
  } finally {
    try { process.kill(Number(readFileSync(leftover, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
    f.close();
  }
});

test("a chat reply's screenshot is published even when a leftover tool keeps stdout open past the deadline", async () => {
  const f = repoFixture();
  const leftover = join(f.dir, "leftover.pid");
  try {
    f.pi(`printf '\\211PNG\\r\\n\\032\\n0000' > "$TMPDIR/shot.png"
echo "{\\"type\\":\\"message_update\\",\\"assistantMessageEvent\\":{\\"type\\":\\"text_delta\\",\\"delta\\":\\"See ![shot]($TMPDIR/shot.png)\\"}}"
printf '%s' "$TMPDIR" > '${f.seen}'
${settled}
sleep 30 &
echo $! > '${leftover}'`);
    const repoBoard = f.board.addRepo(f.repo), sessionDir = join(f.dir, "sessions");
    const chats = new Chats(f.board, { piBin: f.fakePi, sessionDir, cli: "cli", env: process.env });
    const chat = f.board.createChat(repoBoard.id);
    const finished = new Promise<void>(resolve => { const off = chats.subscribe(chat.id, event => { if (event.type === "live" && event.live === null) { off(); resolve(); } }); });
    chats.send(repoBoard, chat.id, "hello");
    await finished;
    assert.ok(alive(Number(readFileSync(leftover, "utf8"))), "the leftover held stdout for the whole turn");
    const reply = f.board.listChatMessages(chat.id).find(message => message.role === "agent")!;
    const image = /\/api\/boards\/[^/]+\/chats\/[^/]+\/images\/([0-9a-f]{64})\)/.exec(reply.body);
    assert.ok(image, `the saved message links to the published image: ${reply.body}`);
    assert.ok(existsSync(chatImagePath(sessionDir, chat.id, image[1])));
    await waitFor(() => !existsSync(readFileSync(f.seen, "utf8")));
  } finally {
    try { process.kill(Number(readFileSync(leftover, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
    f.close();
  }
});

/** Fails the n-th write of the owner record with ENOSPC, and records each child spawnPi starts. */
function diskFullAt(n: number) {
  const spawned: ChildProcess[] = [];
  let writes = 0;
  const realWrite = fs.writeFileSync, realSpawn = childProcess.spawn;
  const write = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith(".alice-owner.tmp") && ++writes === n) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    return realWrite(...args);
  });
  const start = mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => { const child = realSpawn(...args); spawned.push(child); return child; });
  syncBuiltinESMExports();
  return { spawned, restore: () => { write.mock.restore(); start.mock.restore(); syncBuiltinESMExports(); } };
}

test("a full disk at the first owner write removes the new directory and starts no Pi", () => {
  const id = randomUUID(), disk = diskFullAt(1);
  try { assert.throws(() => spawnPi(id, "sleep", ["30"], { stdio: "ignore" }), /ENOSPC/); }
  finally { disk.restore(); }
  assert.equal(disk.spawned.length, 0);
  assert.equal(existsSync(runTempDir(id)), false);
});

test("a full disk at the second owner write kills the Pi it just started and removes its directory", async () => {
  const id = randomUUID(), disk = diskFullAt(2);
  try { assert.throws(() => spawnPi(id, "sleep", ["30"], { stdio: "ignore" }), /ENOSPC/); }
  finally { disk.restore(); }
  assert.equal(disk.spawned.length, 1);
  const [child] = disk.spawned;
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
  assert.equal(child.signalCode, "SIGKILL");
  await waitFor(() => !existsSync(runTempDir(id)));
});

test("startup sweeps only Alice's own leftovers whose server and Pi are both gone", () => {
  const made: string[] = [];
  const dead = { pid: spawnSync(process.execPath, ["-e", ""]).pid!, start: null };
  const leftover = (owner: unknown) => {
    const dir = runTempDir(randomUUID());
    mkdirSync(dir); made.push(dir);
    writeFileSync(join(dir, "scratch"), "x");
    if (owner !== undefined) writeFileSync(join(dir, ".alice-owner"), JSON.stringify(owner));
    return dir;
  };
  try {
    const unrelated = mkdtempSync(join(dirname(runTempDir("x")), "alice-run-temp-")); made.push(unrelated);
    const crashed = leftover({ server: dead, pi: { ...dead } });
    const reusedPid = leftover({ server: { pid: process.pid, start: "not-this-process" }, pi: null });
    const unmarked = leftover(undefined), garbled = leftover("nonsense");
    const otherAlice = leftover({ server: { pid: process.ppid, start: null }, pi: dead });
    sweepRunTemp();
    assert.deepEqual([crashed, reusedPid].map(existsSync), [false, false], "a dead owner, or a reused pid, is a leftover");
    assert.deepEqual([unrelated, unmarked, garbled].map(existsSync), [true, true, true], "anything without Alice's name and owner record is left alone");
    assert.equal(existsSync(otherAlice), true, "another live Alice keeps its directories");
  } finally { for (const dir of made) rmSync(dir, { recursive: true, force: true }); }
});

test("after a crash, startup keeps an orphaned Pi's TMPDIR while it runs and removes it once that Pi is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-orphan-")), script = join(dir, "server.ts"), pidFile = join(dir, "pi.pid"), id = randomUUID();
  let piPid = 0;
  try {
    // A stand-in server starts a chat-like Pi and dies without cleaning up, as on SIGKILL or a power cut.
    writeFileSync(script, `import { writeFileSync } from "node:fs";
import { spawnPi } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "run-temp.ts")).href)};
const child = spawnPi(${JSON.stringify(id)}, "sleep", ["30"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.kill(process.pid, "SIGKILL");
`);
    const server = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore" });
    await new Promise(resolve => server.once("exit", resolve));
    piPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(piPid), "the orphaned Pi outlived its server");
    sweepRunTemp();
    assert.ok(existsSync(runTempDir(id)), "a live orphan keeps its directory");
    process.kill(piPid, "SIGKILL");
    await waitFor(() => !alive(piPid));
    sweepRunTemp();
    assert.equal(existsSync(runTempDir(id)), false);
  } finally {
    if (piPid && alive(piPid)) process.kill(piPid, "SIGKILL");
    rmSync(runTempDir(id), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each spawn creates its directory exclusively and refuses a path that already exists", () => {
  const id = randomUUID();
  mkdirSync(runTempDir(id));
  try { assert.throws(() => spawnPi(id, "true", [], { stdio: "ignore" }), /EEXIST/); }
  finally { rmSync(runTempDir(id), { recursive: true, force: true }); }
  assert.equal(readdirSync(dirname(runTempDir(id))).includes(`alice-run-${id}`), false);
});
