import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

test("SIGTERM exits the server even while a card run's Pi ignores SIGTERM: it is killed and its TMPDIR removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-shutdown-stubborn-"));
  const repo = join(home, "code", "alpha"), dataDir = join(home, "data"), fakePi = join(home, "pi"), seen = join(home, "seen");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial"]);
  // An ignored signal stays ignored across exec, so this Pi only goes on SIGKILL.
  writeFileSync(fakePi, `#!/bin/sh\ntrap '' TERM\necho "$$ $TMPDIR" >> '${seen}'\nexec sleep 60\n`);
  chmodSync(fakePi, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ALICE_HOST: "", ALICE_ALLOWED_HOSTS: "", HOME: home, ALICE_DATA_DIR: dataDir, ALICE_PORT: String(port), ALICE_SENTINEL: "0", ALICE_PI_BIN: fakePi, ALICE_WT_BIN: join(home, "no-wt") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  const pi = () => existsSync(seen) ? readFileSync(seen, "utf8").trim().split(" ") : [];
  const alive = (pid: string) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
  try {
    const url = `http://127.0.0.1:${port}`;
    const post = async (path: string, input?: unknown) => (await fetch(`${url}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input ?? {}) })).json();
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`${url}/api/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const boardId = (await post("/boards", { repo })).id;
    const cardId = (await post(`/boards/${boardId}/cards`, { title: "Stubborn", body: "" })).id;
    await post(`/boards/${boardId}/cards/${cardId}/status`, { status: "ready" });
    await post(`/boards/${boardId}/cards/${cardId}/start`);
    const started = Date.now() + 10_000;
    while (pi().length < 2 && Date.now() < started) await new Promise(resolve => setTimeout(resolve, 25));
    const [pid, dir] = pi();
    assert.ok(pid && existsSync(dir), `the card's Pi started with its TMPDIR: ${output}`);

    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    child.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 30_000))]);
    assert.notEqual(result, "hung", `server did not exit after SIGTERM: ${output}`);
    assert.equal(result, 0, `server exited with ${result}: ${output}`);
    assert.equal(alive(pid), false, "the Pi that ignored SIGTERM was killed");
    assert.equal(existsSync(dir), false);
    const db = new DatabaseSync(join(dataDir, "alice.sqlite"));
    try { assert.match(String((db.prepare("SELECT error FROM runs").get() as { error: string }).error), /Alice sent SIGTERM: server received SIGTERM/); }
    finally { db.close(); }
  } finally {
    child.kill("SIGKILL");
    const [pid] = pi();
    if (pid && alive(pid)) process.kill(Number(pid), "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("SIGTERM stops a chat turn and its topic writer, and removes their TMPDIRs, before the server exits", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-shutdown-chat-"));
  const repo = join(home, "code", "alpha"), dataDir = join(home, "data"), fakePi = join(home, "pi"), seen = join(home, "seen");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  // Both the reply and the topic writer get this Pi, which records itself and then waits to be stopped.
  writeFileSync(fakePi, `#!/bin/sh\necho "$$ $TMPDIR" >> '${seen}'\nexec sleep 30\n`);
  chmodSync(fakePi, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ALICE_HOST: "", ALICE_ALLOWED_HOSTS: "", HOME: home, ALICE_DATA_DIR: dataDir, ALICE_PORT: String(port), ALICE_SENTINEL: "0", ALICE_PI_BIN: fakePi },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  const lines = () => existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").map(line => line.split(" ")) : [];
  const alive = (pid: string) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
  try {
    const url = `http://127.0.0.1:${port}`;
    const post = async (path: string, input: unknown) => (await fetch(`${url}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json();
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`${url}/api/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const boardId = (await post("/boards", { repo })).id;
    const chatId = (await post(`/boards/${boardId}/chats`, {})).id;
    await post(`/boards/${boardId}/chats/${chatId}/messages`, { message: "what is on the board?" });
    const started = Date.now() + 10_000;
    while (lines().length < 2 && Date.now() < started) await new Promise(resolve => setTimeout(resolve, 25));
    const pis = lines();
    assert.equal(pis.length, 2, `the reply and the topic writer both started: ${output}`);
    for (const [, dir] of pis) assert.ok(existsSync(dir), "each Pi has its directory while it runs");

    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    child.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 20_000))]);
    assert.notEqual(result, "hung", `server did not exit after SIGTERM: ${output}`);
    assert.equal(result, 0, `server exited with ${result}: ${output}`);
    assert.deepEqual(pis.map(([pid]) => alive(pid)), [false, false], "no Pi outlives the server");
    assert.deepEqual(pis.map(([, dir]) => existsSync(dir)), [false, false], "and their directories are gone");
  } finally {
    child.kill("SIGKILL");
    for (const [pid] of lines()) if (alive(pid)) process.kill(Number(pid), "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

// An open browser tab holds a chat event stream. If shutdown leaves it open, the process never exits, systemd never
// restarts it, and the tab keeps talking to a server whose database is closed.
// Windows cannot deliver SIGTERM (child.kill() ends the process outright), so there the same shutdown is asked for over IPC.
test("a shutdown request exits the server even while a chat event stream is open", async () => {
  const home = mkdtempSync(join(tmpdir(), "alice-shutdown-"));
  const repo = join(home, "code", "alpha"), dataDir = join(home, "data");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ALICE_HOST: "", ALICE_ALLOWED_HOSTS: "", HOME: home, ALICE_DATA_DIR: dataDir, ALICE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}`;
    const post = async (path: string, input: unknown) => (await fetch(`${url}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json();
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`${url}/api/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const boardId = (await post("/boards", { repo })).id;
    const chatId = (await post(`/boards/${boardId}/chats`, {})).id;
    const stream = httpRequest(`${url}/api/boards/${boardId}/chats/${chatId}/events?viewer=test&looking=1`);
    stream.on("error", () => undefined);
    await new Promise<void>(resolve => { stream.on("response", response => { response.resume(); resolve(); }); stream.end(); });

    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    if (process.platform === "win32") child.send({ type: "shutdown" }); else child.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 10_000))]);
    stream.destroy();
    assert.notEqual(result, "hung", `server did not exit after the shutdown request: ${output}`);
    assert.equal(result, 0, `server exited with ${result}: ${output}`);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
