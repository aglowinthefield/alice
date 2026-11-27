import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const cli = fileURLToPath(new URL("../scripts/alice.mjs", import.meta.url));
const board = { id: "board-one", repo: resolve("/tmp/alice-project"), limitsEnabled: true, autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 6, autoPickupStarts: 6, autoPickupNextAt: "2026-10-26T07:04:01.000Z", autoReviewEnabled: false, autoPickupError: "" };

const cards = [
  { id: "card-one", title: "Make an improvement", body: "Line one\nLine two", repo: board.repo, status: "triage", priority: 50, attempts: 3, reviewRounds: 2 },
  { id: "card-done", title: "Finished", body: "", repo: board.repo, status: "done", attempts: 0, reviewRounds: 0 },
  { id: "card-old", title: "Old work", body: "", repo: board.repo, status: "archived", attempts: 0, reviewRounds: 0 },
];

async function fixture(boards: object[] = [board]) {
  const requests: { method: string; path: string; input: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : undefined;
    const path = req.url ?? "";
    requests.push({ method: req.method ?? "GET", path, input });
    res.setHeader("content-type", "application/json");
    let data: unknown;
    if (path === "/api/boards" && req.method === "POST") { res.writeHead(201); data = { id: "board-new", repo: (input as { repo: string }).repo }; }
    else if (path === "/api/status") data = { version: "9.8.7", commit: "abc1234" };
    else if (path === "/api/settings") data = { maxActiveAgents: req.method === "PATCH" ? (input as { maxActiveAgents: number }).maxActiveAgents : 0, activeAgentsLimit: req.method === "PATCH" && (input as { maxActiveAgents: number }).maxActiveAgents ? (input as { maxActiveAgents: number }).maxActiveAgents : 4, activeAgents: 3 };
    else if (path === "/api/boards") data = boards;
    else if (path === `/api/boards/${board.id}/cards` && req.method === "GET") data = cards;
    else if (/^\/api\/boards\/board-one\/cards\/[\w-]+$/.test(path) && req.method === "PATCH") {
      const card = cards.find(item => item.id === path.split("/")[5]);
      if (!card) { res.writeHead(404); res.end(JSON.stringify({ error: "Card not found on this board" })); return; }
      data = { ...card, ...(input as object) };
    }
    else if (/^\/api\/boards\/board-one\/cards\/(archive|unarchive)$/.test(path) && req.method === "POST") {
      const archive = path.endsWith("/archive"), ids = (input as { cardIds: string[] }).cardIds;
      if (ids.some(id => cards.find(item => item.id === id)?.status !== (archive ? "done" : "archived"))) {
        res.writeHead(400); res.end(JSON.stringify({ error: archive ? "Only Done cards can be archived" : "Only archived cards can be restored" })); return;
      }
      data = ids.map(id => ({ ...cards.find(item => item.id === id), status: archive ? "archived" : "done" }));
    }
    else if (path === `/api/boards/${board.id}/cards/purge-attachments` && req.method === "POST") data = (input as { cardIds: string[] }).cardIds.map(cardId => ({ cardId, files: 2, bytes: 10 }));
    else if (path === `/api/boards/${board.id}/cards` && req.method === "POST") data = { id: "new-card", ...(input as object), status: "triage" };
    else if (/^\/api\/boards\/board-one\/cards\/card-(one|flagged)\/status$/.test(path) && req.method === "POST") data = { id: path.split("/")[5], status: (input as { status: string }).status };
    // card-one stands in for an older server without the check, which answers 404.
    else if (path === `/api/boards/${board.id}/cards/card-flagged/ready-check`) data = { flags: [
      { rule: "person-only", message: "Needs a physical device, which the agent does not have", quote: "Verify on a physical iPhone." },
      { rule: "no-acceptance", message: "No acceptance criteria" },
    ] };
    else if (/^\/api\/boards\/board-one\/cards\/card-(one|two)\/start$/.test(path) && req.method === "POST") data = { id: `run-${path.split("/")[5]}`, attempt: 2, status: "running" };
    else if (path === `/api/boards/${board.id}/cards/card-three/start` && req.method === "POST") { res.writeHead(400); res.end(JSON.stringify({ error: "Move this card to Ready before starting a run" })); return; }
    else if (path === `/api/boards/${board.id}/cards/card-one/runs`) data = [
      { id: "run-two", attempt: 2, status: "review", agent: "pi/claude", error: null, startedBy: "manual", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.42 },
      { id: "run-one", attempt: 1, status: "failed", agent: "", error: "Pi exited with code 1", startedBy: "auto", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null },
    ];
    else if (path === `/api/boards/${board.id}/cards/card-one/auto-review`) data = [{ runId: "run-two", state: "needs_human", details: "Verification failed", agent: "", inputTokens: 800, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.08 }];
    else if (/^\/api\/boards\/board-one\/cards\/card-done\/(runs|auto-review)$/.test(path)) data = [];
    else if (path === `/api/boards/${board.id}/cards/card-one/dependencies` && req.method === "GET") data = {
      dependsOn: [{ id: "card-done", title: "Finished", status: "done" }, { id: "card-ready", title: "Not yet", status: "ready" }],
      dependents: [{ id: "card-later", title: "Follow-up", status: "triage" }],
    };
    else if (path === `/api/boards/${board.id}/cards/card-done/dependencies`) data = { dependsOn: [], dependents: [] };
    else if (path === `/api/boards/${board.id}/cards/card-one/dependencies` && req.method === "POST") {
      const other = (input as { dependsOn: string }).dependsOn;
      if (other === "card-one") { res.writeHead(400); res.end(JSON.stringify({ error: "A card cannot depend on itself" })); return; }
      data = { ...cards[0], dependsOn: [other], blocked: true };
    }
    else if (/^\/api\/boards\/board-one\/cards\/card-one\/dependencies\/[\w-]+$/.test(path) && req.method === "DELETE") data = { ...cards[0], dependsOn: [], blocked: false };
    else if (path === `/api/boards/${board.id}/sentinels`) data = [{ sentinel: { id: "sen-one", kind: "pr-health", enabled: true, intervalMs: 300000, nextRunAt: "2026-01-01T00:05:00Z" }, runs: [{ status: "succeeded", startedAt: "2026-01-01T00:00:00Z" }], jobs: [] }];
    else if (path === "/api/sentinels/sen-one" && req.method === "PATCH") data = { id: "sen-one", kind: "pr-health", enabled: (input as { enabled: boolean }).enabled, nextRunAt: "2026-01-01T00:05:00Z" };
    else if (path === `/api/boards/${board.id}/conflicts`) data = [{ cardId: "card-one", details: "merge conflict" }];
    else if (path === `/api/boards/${board.id}/settings` && req.method === "PATCH") data = { ...board, ...(input as object) };
    else if (path === `/api/boards/${board.id}/auto-pickup/reset-limit` && req.method === "POST") data = { ...board, autoPickupStarts: 0, autoPickupNextAt: null };
    else { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
    res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const runAt = async (url: string, cwd: string | undefined, ...args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ALICE_URL: url, FORCE_COLOR: "", NO_COLOR: "" } });
    let stdout = "", stderr = "";
    for await (const chunk of child.stdout) stdout += chunk;
    for await (const chunk of child.stderr) stderr += chunk;
    const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    return { code, stdout, stderr };
  };
  const runIn = (cwd: string | undefined, ...args: string[]) => runAt(`http://127.0.0.1:${port}`, cwd, ...args);
  const run = (...args: string[]) => runIn(undefined, ...args);
  return { requests, run, runIn, runAt, port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("lists sentinels and pauses and resumes one", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("sentinels")).stdout, /sen-one\tpr-health\tenabled\tevery:300s.*succeeded/);
    assert.match((await f.run("sentinel-pause", "sen-one")).stdout, /paused/);
    assert.match((await f.run("sentinel-resume", "sen-one")).stdout, /enabled/);
  } finally { await f.close(); }
});

test("ALICE_URL without a scheme falls back to HTTP when HTTPS does not answer", async () => {
  const f = await fixture();
  try {
    const result = await f.runAt(`127.0.0.1:${f.port}`, undefined, "boards");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /alice-project/);
  } finally { await f.close(); }
});

test("lists boards, cards, runs and conflicts through the HTTP API", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("boards")).stdout, /alice-project/);
    assert.match((await f.run("cards")).stdout, /card-one\ttriage\tpriority:high\tattempts:3\treview-rounds:2\tMake an improvement/);
    const runs = JSON.parse((await f.run("runs", "card-one", "--json")).stdout);
    assert.equal(runs.cardId, "card-one");
    assert.deepEqual(runs.runs.map((run: { id: string }) => run.id), ["run-two", "run-one"]);
    assert.equal(runs.reviews.length, 1);
    assert.deepEqual(runs.total, { inputTokens: 2000, outputTokens: 320, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.5, incomplete: true });
    const text = (await f.run("runs", "card-one")).stdout;
    assert.match(text, /run-two.*\$0\.42 \(1200 in, 300 out, 5000 cache read, 100 cache write\)/);
    assert.match(text, /run-one\tfailed.*\t—/, "an older attempt without usage shows a dash, not $0");
    assert.match(text, /^total\t\$0\.50 .*older attempts not recorded/m);
    assert.match((await f.run("conflicts")).stdout, /merge conflict/);
    assert.deepEqual(f.requests.map(r => r.path), ["/api/boards", "/api/boards", `/api/boards/${board.id}/cards`, "/api/boards", `/api/boards/${board.id}/cards/card-one/runs`, `/api/boards/${board.id}/cards/card-one/auto-review`,
      "/api/boards", `/api/boards/${board.id}/cards/card-one/runs`, `/api/boards/${board.id}/cards/card-one/auto-review`, "/api/boards", `/api/boards/${board.id}/conflicts`]);
  } finally { await f.close(); }
});

test("card creation and status changes go through the API; Ready needs consent when pickup is on", async () => {
  const f = await fixture();
  try {
    const unconfirmed = await f.run("ready", "card-one");
    assert.notEqual(unconfirmed.code, 0);
    assert.match(unconfirmed.stderr, /--yes/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    const ready = await f.run("ready", "card-one", "--yes");
    assert.equal(ready.code, 0, ready.stderr);
    const created = await f.run("create", "--title", "New task", "--body", "Do it safely", "--json");
    assert.equal(created.code, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).id, "new-card");
    const triage = await f.run("triage", "card-one");
    assert.equal(triage.code, 0, triage.stderr);
    const urgent = await f.run("create", "--title", "Hotfix", "--priority", "urgent");
    assert.equal(urgent.code, 0, urgent.stderr);
    const bad = await f.run("create", "--title", "Nope", "--priority", "critical");
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Priority must be a whole number from -100 to 100/);
    assert.match((await f.run("cards", "--priority", "high")).stderr, /only valid with create/);
    const keyed = await f.run("create", "--title", "Scripted", "--key", "nightly-1");
    assert.equal(keyed.code, 0, keyed.stderr);
    assert.equal(keyed.stdout, "new-card\ttriage\tpriority:normal\tScripted\n");
    assert.match((await f.run("cards", "--key", "nightly-1")).stderr, /only valid with create/);
    assert.match((await f.run("create", "--title", "Long", "--key", "k".repeat(201))).stderr, /1 to 200/);
    assert.equal((await f.run("create", "--title", "From Hermes", "--source", "hermes")).code, 0);
    assert.match((await f.run("cards", "--source", "hermes")).stderr, /only valid with create or add/);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => r.input), [{ status: "ready" }, { title: "New task", body: "Do it safely", source: "cli" }, { status: "triage" }, { title: "Hotfix", body: "", source: "cli", priority: "urgent" }, { title: "Scripted", body: "", source: "cli", idempotencyKey: "nightly-1" }, { title: "From Hermes", body: "", source: "hermes" }]);
  } finally { await f.close(); }
});

test("ready lists a Triage card's flags and moves it only with --yes", async () => {
  const f = await fixture([{ ...board, autoPickupEnabled: false }]);
  try {
    const flagged = await f.run("ready", "card-flagged");
    assert.notEqual(flagged.code, 0);
    assert.match(flagged.stderr, /may need another pass/);
    assert.match(flagged.stderr, /Needs a physical device.*"Verify on a physical iPhone\."/);
    assert.match(flagged.stderr, /No acceptance criteria/);
    assert.match(flagged.stderr, /alice edit card-flagged .*--yes to move it to Ready anyway/s);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0, "a flagged card stays in Triage");
    const anyway = await f.run("ready", "card-flagged", "--yes");
    assert.equal(anyway.code, 0, anyway.stderr);
    assert.match(anyway.stderr, /moving to Ready anyway:\n  - Needs a physical device/);
    assert.equal(anyway.stdout, "card-flagged\tready\t\n");
    const unchecked = await f.run("ready", "card-one");
    assert.equal(unchecked.code, 0, "a server without the check still moves the card");
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => r.path), [`/api/boards/${board.id}/cards/card-flagged/status`, `/api/boards/${board.id}/cards/card-one/status`]);
  } finally { await f.close(); }
});

test("add captures a Triage card on the board for the current directory", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "alice-add-")));
  const alpha = join(root, "alpha"), beta = join(root, "beta"), elsewhere = join(root, "elsewhere");
  for (const dir of [join(alpha, "src"), beta, elsewhere]) mkdirSync(dir, { recursive: true });
  const f = await fixture([{ ...board, repo: alpha }, { ...board, id: "board-two", repo: beta }]);
  try {
    const added = await f.runIn(join(alpha, "src"), "add", "Fix", "the flaky test", "--priority", "high");
    assert.equal(added.code, 0, added.stderr);
    assert.equal(added.stdout, "new-card\ttriage\tpriority:high\tFix the flaky test\n");
    await f.runIn(beta, "add", "Beta idea");
    const ambiguous = await f.runIn(elsewhere, "add", "Lost idea");
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.stderr, /More than one board/);
    assert.match((await f.runIn(alpha, "add")).stderr, /add requires a title/);
    const chosen = await f.runIn(elsewhere, "add", "Chosen", "--board", alpha);
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => [r.path, r.input]), [
      ["/api/boards/board-one/cards", { title: "Fix the flaky test", body: "", source: "cli", priority: "high" }],
      ["/api/boards/board-two/cards", { title: "Beta idea", body: "", source: "cli" }],
      ["/api/boards/board-one/cards", { title: "Chosen", body: "", source: "cli" }],
    ]);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("pickup enable needs consent; disable and concurrency changes use settings API", async () => {
  const f = await fixture();
  try {
    assert.notEqual((await f.run("pickup", "on")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "PATCH").length, 0);
    const enabled = await f.run("pickup", "on", "--concurrency", "2", "--limit", "99", "--yes");
    assert.equal(enabled.code, 0, enabled.stderr);
    const disabled = await f.run("pickup", "off");
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => r.input), [
      { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 99 },
      { autoPickupEnabled: false, pickupConcurrency: 2, pickupDailyLimit: 6 },
    ]);
  } finally { await f.close(); }
});

test("open prints and opens the board or a card by its short ID, through $BROWSER", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "alice-open-")), log = join(dir, "opened.txt"), browser = join(dir, "browser");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`); chmodSync(browser, 0o755);
  const saved = process.env.BROWSER;
  process.env.BROWSER = browser;
  try {
    const boardOnly = await f.run("open");
    assert.equal(boardOnly.code, 0, boardOnly.stderr);
    assert.match(boardOnly.stdout, /\/board\/board-one\n$/);
    const card = await f.run("open", "card-on");
    assert.equal(card.code, 0, card.stderr);
    assert.match(card.stdout, /\/board\/board-one\/card\/card-one\n$/);
    assert.match((await f.run("open", "card-")).stderr, /More than one card starts with card-/);
    assert.match((await f.run("open", "nope")).stderr, /Card not found on this board: nope/);
    const printed = await f.run("open", "card-one", "--print");
    assert.match(printed.stdout, /\/board\/board-one\/card\/card-one\n$/);
    assert.notEqual((await f.run("cards", "--print")).code, 0, "--print only goes with open");
    // The browser runs detached; wait for both opens to land.
    for (let i = 0; i < 50 && (!existsSync(log) || readFileSync(log, "utf8").trim().split("\n").length < 2); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map(url => new URL(url).pathname), ["/board/board-one", "/board/board-one/card/card-one"]);
  } finally {
    if (saved === undefined) delete process.env.BROWSER; else process.env.BROWSER = saved;
    rmSync(dir, { recursive: true, force: true });
    await f.close();
  }
});

test("agents shows and sets the agents-at-once limit across all boards", async () => {
  const f = await fixture();
  try {
    const shown = await f.run("agents");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Agents at once, all boards: 4 \(automatic\); 3 running now\./);
    assert.match((await f.run("agents", "2")).stdout, /^Agents at once, all boards: 2; 3 running now\./);
    assert.equal((await f.run("agents", "auto")).code, 0);
    assert.notEqual((await f.run("agents", "lots")).code, 0);
    assert.notEqual((await f.run("agents", "--board", "board-one")).code, 0);
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => r.input), [{ maxActiveAgents: 2 }, { maxActiveAgents: 0 }]);
  } finally { await f.close(); }
});

test("limits shows the spend limits and turns them on or off for one board", async () => {
  const f = await fixture();
  try {
    const shown = await f.run("limits");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Limits on: 6 starts per 24h; no budget; .*loop guards always apply\.\nAll boards: 3 of 4 agents running \(alice agents\)\.\n$/);
    const off = await f.run("limits", "off");
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /^Limits off \(stored, not applied\)/);
    assert.notEqual((await f.run("limits", "maybe")).code, 0);
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => r.input), [{ limitsEnabled: false }]);
  } finally { await f.close(); }
});

test("board shows the auto-review state, and the removed --merge-limit is refused", async () => {
  const f = await fixture();
  try {
    assert.notEqual((await f.run("board", "--merge-limit", "3")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "PATCH").length, 0);
    const shown = await f.run("board");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /review:(on|off)/);
  } finally { await f.close(); }
});
test("pickup shows the rolling limit and requires consent to reset it", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("pickup")).stdout, /6\/6 starts.*next slot/);
    assert.match((await f.run("pickup", "reset")).stderr, /--yes/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    const reset = await f.run("pickup", "reset", "--yes");
    assert.equal(reset.code, 0, reset.stderr);
    assert.match(reset.stdout, /0\/6 starts/);
    assert.equal(f.requests.filter(r => r.method === "POST")[0].path, `/api/boards/${board.id}/auto-pickup/reset-limit`);
  } finally { await f.close(); }
});

test("a daily pickup limit of 0 means no limit in output and settings", async () => {
  const limited = await fixture();
  try {
    assert.match((await limited.run("stats")).stdout, /Pickup on; concurrency 2; 6\/6 starts in 24h; next slot/);
    const off = await limited.run("pickup", "on", "--limit", "off", "--yes");
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /; 6 starts in 24h \(no limit\);/);
    assert.equal((await limited.run("pickup", "on", "--limit", "0", "--yes")).code, 0);
    for (const bad of ["-1", "100", "1.5", "none"]) assert.match((await limited.run("pickup", "on", "--limit", bad, "--yes")).stderr, /Limit must be off, 0 \(no limit\) or an integer from 1 to 99/);
    assert.deepEqual(limited.requests.filter(r => r.method === "PATCH").map(r => (r.input as { pickupDailyLimit: number }).pickupDailyLimit), [0, 0]);
  } finally { await limited.close(); }
  const unlimited = await fixture([{ ...board, pickupDailyLimit: 0, autoPickupStarts: 8, autoPickupNextAt: null }]);
  try {
    assert.match((await unlimited.run("stats")).stdout, /Pickup on; concurrency 2; 8 starts in 24h \(no limit\); \$0\.00 spent/);
    assert.doesNotMatch((await unlimited.run("pickup")).stdout, /\//);
    const on = await unlimited.run("pickup", "on", "--yes");
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /starts in 24h \(no limit\)/);
    const disabled = await unlimited.run("pickup", "off");
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.match(disabled.stdout, /^Pickup off; concurrency 2; \d+ starts in 24h \(no limit\)/);
    const limit = await unlimited.run("pickup", "on", "--limit", "4", "--yes");
    assert.match(limit.stdout, /\d+\/4 starts in 24h/);
    assert.deepEqual(unlimited.requests.filter(r => r.method === "PATCH").map(r => r.input), [
      { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 0 },
      { autoPickupEnabled: false, pickupConcurrency: 2, pickupDailyLimit: 0 },
      { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 4 },
    ]);
  } finally { await unlimited.close(); }
});

test("ambiguous boards require a selector and bad card ids fail before mutation", async () => {
  const f = await fixture([board, { ...board, id: "board-two", repo: resolve("/tmp/another-project") }]);
  try {
    assert.match((await f.run("cards")).stderr, /More than one board/);
    assert.match((await f.run("cards", "--board", board.repo)).stdout, /card-one/);
    assert.notEqual((await f.run("ready", "../evil", "--board", board.id, "--yes")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("start needs consent, starts each card independently, and reports refusals", async () => {
  const f = await fixture();
  try {
    const unconfirmed = await f.run("start", "card-one", "card-two");
    assert.notEqual(unconfirmed.code, 0);
    assert.match(unconfirmed.stderr, /2 runs uses paid Pi.*--yes/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    assert.notEqual((await f.run("start", "../evil", "--yes")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    const started = await f.run("start", "card-one", "card-three", "card-two", "--yes");
    assert.equal(started.code, 1);
    assert.match(started.stdout, /card-one\tattempt #2\trunning/);
    assert.match(started.stdout, /card-three\terror\tAlice 400: Move this card to Ready/);
    assert.match(started.stdout, /card-two\tattempt #2\trunning/);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => r.path), ["card-one", "card-three", "card-two"].map(id => `/api/boards/${board.id}/cards/${id}/start`));
  } finally { await f.close(); }
});

test("pickup shows 24-hour spend and sets or clears an optional cost budget", async () => {
  const f = await fixture([{ ...board, cost24h: 4.5, pickupCostBudget: 4, autoPickupBudgetReached: true }]);
  try {
    assert.match((await f.run("pickup")).stdout, /\$4\.50 spent in 24h of \$4\.00 budget \(waiting: budget reached\)/);
    assert.match((await f.run("pickup", "on", "--budget", "-1", "--yes")).stderr, /Budget must be off/);
    assert.match((await f.run("runs", "card-one", "--budget", "5")).stderr, /only valid with pickup/);
    assert.equal((await f.run("pickup", "on", "--budget", "$12.5", "--yes")).code, 0);
    assert.equal((await f.run("pickup", "off", "--budget", "off")).code, 0);
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => (r.input as { pickupCostBudget?: unknown }).pickupCostBudget), [12.5, null]);
  } finally { await f.close(); }
});

test("show prints the card, its attempts and the latest auto-review verdict", async () => {
  const f = await fixture();
  try {
    const shown = await f.run("show", "card-one");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Make an improvement$/m);
    assert.match(shown.stdout, /^status\ttriage$/m);
    assert.equal(shown.stdout.split("\n").includes(`repo\t${board.repo}`), true);
    assert.match(shown.stdout, /^Line one\nLine two$/m);
    assert.match(shown.stdout, /^#2\treview\tpi\/claude$/m);
    assert.match(shown.stdout, /^depends on\tcard-done\tdone\tFinished\ndepends on\tcard-ready\tready\tNot yet\ndependent\tcard-later\ttriage\tFollow-up$/m);
    assert.match(shown.stdout, /^#1\tfailed\t-\tPi exited with code 1$/m);
    assert.match(shown.stdout, /^auto-review\tneeds_human\tVerification failed$/m);
    const json = JSON.parse((await f.run("show", "card-one", "--json")).stdout);
    assert.equal(json.card.id, "card-one");
    assert.equal(json.runs.length, 2);
    assert.equal(json.review.runId, "run-two");
    const unstarted = (await f.run("show", "card-done")).stdout;
    assert.match(unstarted, /^\(no description\)$/m);
    assert.match(unstarted, /^attempts\t0\nauto-review\tnone$/m);
    assert.match(unstarted, /^depends on\tnone\ndependent\tnone$/m);
    const missing = await f.run("show", "card-gone");
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /Card not found on this board: card-gone/);
    assert.notEqual((await f.run("show", "../evil")).code, 0);
  } finally { await f.close(); }
});

test("edit patches title and description, keeping the field not supplied", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("edit", "card-one")).stderr, /--title TITLE and\/or --body BODY/);
    assert.match((await f.run("cards", "--title", "x")).stderr, /only valid with create, add or edit/);
    assert.match((await f.run("edit", "card-one", "--title", "  ")).stderr, /cannot be empty/);
    assert.equal((await f.run("edit", "card-one", "--title", "Renamed")).code, 0);
    assert.equal((await f.run("edit", "card-one", "--body", "")).code, 0);
    const both = await f.run("edit", "card-one", "--title", "T", "--body", "B", "--json");
    assert.equal(both.code, 0, both.stderr);
    assert.equal(JSON.parse(both.stdout).title, "T");
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => [r.path, r.input]), [
      [`/api/boards/${board.id}/cards/card-one`, { title: "Renamed", body: "Line one\nLine two" }],
      [`/api/boards/${board.id}/cards/card-one`, { title: "Make an improvement", body: "" }],
      [`/api/boards/${board.id}/cards/card-one`, { title: "T", body: "B" }],
    ]);
    assert.equal(f.requests.filter(r => r.path.endsWith("/cards")).length, 2, "both fields given needs no lookup");
  } finally { await f.close(); }
});

test("archive takes Done cards, restore brings one back, and refusals are reported", async () => {
  const f = await fixture();
  try {
    const archived = await f.run("archive", "card-done");
    assert.equal(archived.code, 0, archived.stderr);
    assert.match(archived.stdout, /^card-done\tarchived\tFinished$/m);
    const refused = await f.run("archive", "card-done", "card-one");
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Only Done cards can be archived/);
    const restored = await f.run("restore", "card-old", "--json");
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout)[0].status, "done");
    assert.match((await f.run("restore", "card-old", "card-done")).stderr, /Invalid arguments for restore/);
    assert.notEqual((await f.run("archive", "card-done", "../evil")).code, 0);
    assert.match((await f.run("archive", "card-done", "--yes")).stderr, /--yes is only valid/);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => [r.path, r.input]), [
      [`/api/boards/${board.id}/cards/archive`, { cardIds: ["card-done"] }],
      [`/api/boards/${board.id}/cards/archive`, { cardIds: ["card-done", "card-one"] }],
      [`/api/boards/${board.id}/cards/unarchive`, { cardIds: ["card-old"] }],
    ]);
  } finally { await f.close(); }
});

test("purge-attachments needs --yes and reports what each card lost", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("purge-attachments", "card-old")).stderr, /cannot be undone.*--yes/);
    const purged = await f.run("purge-attachments", "card-old", "--yes");
    assert.equal(purged.code, 0, purged.stderr);
    assert.match(purged.stdout, /^card-old\tpurged 2 files, 10 bytes$/m);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => [r.path, r.input]), [[`/api/boards/${board.id}/cards/purge-attachments`, { cardIds: ["card-old"] }]]);
  } finally { await f.close(); }
});

test("stats prints per-lane counts and pickup state for the selected board", async () => {
  const f = await fixture([{ ...board, cardCounts: { triage: 2, review: 1, done: 4 } }, { ...board, id: "board-two", repo: resolve("/tmp/another-project"), cardCounts: { ready: 9 } }]);
  try {
    assert.match((await f.run("stats")).stderr, /More than one board/);
    const stats = await f.run("stats", "--board", board.id);
    assert.equal(stats.code, 0, stats.stderr);
    assert.match(stats.stdout, /^triage\t2\nready\t0\nrunning\t0\nreview\t1\nfailed\t0\ninterrupted\t0\ndone\t4\narchived\t0\ntotal\t7\nPickup on; concurrency 2; 6\/6 starts/m);
    const json = JSON.parse((await f.run("stats", "--board", board.repo, "--json")).stdout);
    assert.equal(json.boardId, board.id);
    assert.equal(json.total, 7);
    assert.equal(json.counts.ready, 0);
    assert.equal(json.pickup.autoPickupEnabled, true);
    assert.equal(f.requests.filter(r => r.path !== "/api/boards").length, 0, "stats uses only the boards list");
  } finally { await f.close(); }
});

test("create --after and depend/undepend manage card dependencies through the HTTP API", async () => {
  const f = await fixture();
  try {
    const created = await f.run("create", "--title", "Follow-up", "--after", "card-one", "--after", "card-done");
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(f.requests.at(-1), { method: "POST", path: `/api/boards/${board.id}/cards`, input: { title: "Follow-up", body: "", source: "cli", dependsOn: ["card-one", "card-done"] } });
    assert.match(created.stdout, /after:card-one,card-done/);
    const depended = await f.run("depend", "card-one", "--on", "card-done");
    assert.equal(depended.code, 0, depended.stderr);
    assert.deepEqual(f.requests.at(-1), { method: "POST", path: `/api/boards/${board.id}/cards/card-one/dependencies`, input: { dependsOn: "card-done" } });
    assert.match(depended.stdout, /^card-one\ttriage\tMake an improvement\tdepends on:card-done\tblocked$/m);
    const undepended = await f.run("undepend", "card-one", "--on", "card-done");
    assert.equal(undepended.code, 0, undepended.stderr);
    assert.deepEqual(f.requests.at(-1), { method: "DELETE", path: `/api/boards/${board.id}/cards/card-one/dependencies/card-done`, input: undefined });
    assert.match(undepended.stdout, /depends on:none$/m);
    const self = await f.run("depend", "card-one", "--on", "card-one");
    assert.notEqual(self.code, 0);
    assert.match(self.stderr, /cannot depend on itself/);
    assert.match((await f.run("depend", "card-one")).stderr, /depend requires --on CARD_ID/);
    assert.match((await f.run("cards", "--after", "card-one")).stderr, /--after is only valid with create/);
    assert.match((await f.run("create", "--title", "x", "--on", "card-one")).stderr, /--on is only valid with depend or undepend/);
    assert.match((await f.run("create", "--title", "x", "--after", "../evil")).stderr, /card ID/);
    assert.match((await f.run("help", "create")).stdout, /--after CARD_ID/);
    assert.match((await f.run("create", "--help")).stdout, /--after CARD_ID/);
  } finally { await f.close(); }
});

test("doctor reports PASS, WARN and FAIL per check and exits 1 on a failure", async () => {
  const f = await fixture([{ ...board, repo: "/nonexistent/alice-doctor", autoPickupError: "" }]);
  try {
    const result = await f.run("doctor");
    assert.equal(result.code, 1, "a board whose repository is missing fails the run");
    assert.match(result.stdout, /^PASS\tserver\thttp:\/\/127\.0\.0\.1:\d+ \(local, 1 board\)/m);
    assert.match(result.stdout, /^FAIL\tboard \/nonexistent\/alice-doctor\trepository path does not exist/m);
    // pi, gh and Worktrunk may be missing on the machine running the tests, so count the failures instead of fixing them at 1.
    const failed = result.stdout.split("\n").filter(line => line.startsWith("FAIL\t")).length;
    assert.match(result.stdout, new RegExp(`\\d+ passed, \\d+ warnings, ${failed} failed$`, "m"));
    const json = JSON.parse((await f.run("doctor", "--json")).stdout);
    assert.deepEqual(json.find((check: { name: string }) => check.name === "server").status, "pass");
  } finally { await f.close(); }
});

test("doctor exits promptly with its own status when the telemetry route stalls", async () => {
  const stalled: ServerResponse[] = [];
  // How long the CLI held the stalled request open: about 1s when it gives up on its own, 10s on the default timeout.
  // Timed from the request's arrival, so a slow process start on a busy machine doesn't count.
  let held: Promise<number> | undefined;
  const stub = createServer((req, res) => {
    if (req.url === "/api/telemetry/doctor") {
      stalled.push(res);
      const arrived = performance.now();
      held = new Promise(resolve => req.socket.once("close", () => resolve(performance.now() - arrived)));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/status" ? { version: "9.8.7", commit: "abc1234" } : [{ ...board, repo: "/nonexistent/alice-doctor", autoPickupError: "" }]));
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  try {
    const port = (stub.address() as { port: number }).port;
    const child = spawn(process.execPath, [cli, "doctor"], { env: { ...process.env, ALICE_URL: `http://127.0.0.1:${port}` } });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    assert.equal(code, 1);
    assert.match(stdout, /^FAIL\tboard /m);
    assert.equal(stalled.length, 1, "the failure was reported");
    const ms = await held!;
    assert.ok(ms < 8000, `the CLI held the stalled request ${Math.round(ms)}ms, not its own 1s limit`);
  } finally { for (const res of stalled) res.destroy(); await new Promise<void>(resolve => stub.close(() => resolve())); }
});

test("doctor ends with INFO rows for the CLI's ALICE_* variables and the server's settings, hiding secrets", async () => {
  const { doctor, report } = await import(new URL("../scripts/doctor.mjs", import.meta.url).href);
  const checks = await doctor({
    env: { ALICE_URL: "mochi", ALICE_DISCORD_WEBHOOK_URL: "https://discord.example/hook/secret", PATH: "/usr/bin" },
    origin: new URL("http://mochi:4317"), local: false,
    fetchBoards: async () => [],
    fetchStatus: async () => ({ version: "1.2.3", hostname: "mochi", activeRuns: 2, draining: true, features: { sentinels: false, pullRequests: true } }),
    fetchSettings: async () => ({ agentModels: { work: { model: "claude", thinking: "high" }, review: { model: "", thinking: "" } }, telemetryAvailable: true, telemetryEnabled: false, discordWebhookUrl: "https://discord.example/hook/secret" }),
    cliPath: "/opt/alice/scripts/alice.mjs",
  });
  const lines = report(checks);
  const info = lines.filter((line: string) => line.startsWith("INFO\t"));
  assert.deepEqual(info, [
    "INFO\tcli path\t/opt/alice/scripts/alice.mjs",
    "INFO\tenv ALICE_DISCORD_WEBHOOK_URL\tset (hidden)",
    "INFO\tenv ALICE_URL\tmochi",
    "INFO\tserver host\tmochi",
    "INFO\tserver features\tsentinels off, pullRequests on",
    "INFO\tserver runs\t2 active, draining for an update",
    "INFO\tserver models\twork claude (high), review default",
    "INFO\tserver telemetry\toff",
    "INFO\tserver discord\twebhook set",
  ]);
  assert.ok(!lines.some((line: string) => line.includes("secret")), "secret values never print");
  assert.equal(lines.at(-1), "2 passed, 0 warnings, 0 failed", "INFO rows stay out of the count");
  assert.ok(!(await doctor({ env: {}, origin: new URL("http://127.0.0.1:1"), local: false, fetchBoards: async () => { throw new Error("down"); } })).some((check: { name: string }) => check.name.startsWith("server ")), "no server rows when it is unreachable");
});

test("doctor fails the server check when Alice is not running", async t => {
  // An unreadable PATH directory makes a missing binary fail with EACCES, not ENOENT; it must still read as not found.
  const locked = mkdtempSync(join(tmpdir(), "alice-locked-path-"));
  chmodSync(locked, 0o000);
  t.after(() => { chmodSync(locked, 0o700); rmSync(locked, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [cli, "doctor"], { env: { ...process.env, PATH: `${locked}${delimiter}${process.env.PATH}`, ALICE_URL: "http://127.0.0.1:1", ALICE_PI_BIN: "alice-no-such-pi" } });
  let stdout = "";
  for await (const chunk of child.stdout) stdout += chunk;
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  assert.equal(code, 1);
  assert.match(stdout, /^FAIL\tserver\tCannot reach Alice/m);
  assert.match(stdout, /^FAIL\tpi\talice-no-such-pi not found/m);
});

test("board-add posts the repository path to the HTTP API", async () => {
  const f = await fixture();
  try {
    const repo = resolve("/tmp/new-repo");
    const out = JSON.parse((await f.run("board-add", "/tmp/new-repo", "--json")).stdout);
    assert.deepEqual(out, { id: "board-new", repo });
    assert.deepEqual(f.requests.find(item => item.method === "POST" && item.path === "/api/boards")?.input, { repo });
  } finally { await f.close(); }
});

test("--version prints the CLI's package.json version and Git commit", async () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const f = await fixture();
  try {
    const out = (await f.run("--version")).stdout.trim();
    assert.match(out, new RegExp(`^alice ${pkg.version.replace(/\./g, "\\.")}( \\([0-9a-f]{7,}\\))?$`));
    assert.equal(f.requests.length, 0, "--version does not need the server");
  } finally { await f.close(); }
});

test("doctor starts with the CLI version, and adds the server's against a remote ALICE_URL", async () => {
  const f = await fixture();
  try {
    const local = (await f.run("doctor")).stdout.split("\n");
    assert.match(local[0], /^PASS\talice\t\d+\.\d+\.\d+/);
    assert.ok(!local.some(line => line.includes("alice server")), "a local server is this checkout, so one line");
  } finally { await f.close(); }
  // A remote server is any address the CLI does not treat as loopback, so reach a stub through this machine's LAN address.
  const lan = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
  if (!lan) return;
  const stub = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/status" ? { version: "9.8.7", commit: "abc1234" } : [{ ...board, repo: "/srv/remote-only" }]));
  });
  await new Promise<void>(resolve => stub.listen(0, "0.0.0.0", resolve));
  try {
    const port = (stub.address() as { port: number }).port;
    const child = spawn(process.execPath, [cli, "doctor"], { env: { ...process.env, ALICE_URL: `http://${lan}:${port}`, ALICE_ALLOW_REMOTE: "1" } });
    let stdout = "";
    for await (const chunk of child.stdout) stdout += chunk;
    const lines = stdout.split("\n");
    assert.match(lines[0], /^PASS\talice\t\d+\.\d+\.\d+/);
    assert.equal(lines[1], "PASS\talice server\t9.8.7 (abc1234)");
    assert.equal(lines[2], `PASS\tserver\thttp://${lan}:${port} (remote, 1 board)`, "the instance comes right after the versions");
    assert.ok(lines.some(line => line.startsWith(`PASS\tboard ${lan}:/srv/remote-only\t`)), "a remote board's path names its host");
  } finally { await new Promise<void>(resolve => stub.close(() => resolve())); }
});

test("help lists every command the CLI runs, and renders plain off a terminal", async () => {
  const { COMMANDS, commandHelp, overview, suggest } = await import(new URL("../scripts/cli-help.mjs", import.meta.url).href);
  const source = readFileSync(cli, "utf8");
  const expected = source.match(/const expected = \{([^}]*)\}/)![1];
  const variadic = source.match(/const variadic = \[([^\]]*)\]/)![1];
  const handled = new Set([...expected.matchAll(/"?([a-z][a-z-]*)"?:/g), ...variadic.matchAll(/"([a-z-]+)"/g)].map(m => m[1]).concat("pickup", "help"));
  assert.deepEqual([...handled].sort(), COMMANDS.map((item: { name: string }) => item.name).sort());
  assert.doesNotMatch(overview("1.0.0"), /\x1b\[|⣿|b a k e r y/, "no banner or colour when piped");
  for (const item of COMMANDS) assert.match(commandHelp(item.name)!, new RegExp(`alice ${item.name}`));
  assert.equal(suggest("crate"), "create");
  assert.equal(suggest("zzzzzzzz"), undefined);
});

test("a terminal gets aligned, coloured columns; a pipe keeps the tabs", async () => {
  const { layout } = await import(new URL("../scripts/cli-style.mjs", import.meta.url).href);
  const before = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  try {
    const [a, b, plain] = layout(["card-one\ttriage\tpriority:high\tFirst", "c2\tdone\tpriority:normal\tSecond", "no tabs here"]);
    const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
    assert.equal(strip(a), "card-one  triage  priority:high    First");
    assert.equal(strip(b), "c2        done    priority:normal  Second");
    assert.match(b, /\x1b\[32mdone/);
    assert.equal(plain, "no tabs here");
  } finally { if (before === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = before; }
});

test("an unknown command suggests the nearest one", async () => {
  const f = await fixture();
  try {
    const result = await f.run("crate");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown command: crate\. Did you mean create\?/);
  } finally { await f.close(); }
});

test("cards on a terminal show the board's lanes and badges; Archive and old Done cards need --all", async () => {
  const { renderBoard } = await import(new URL("../scripts/cli-board.mjs", import.meta.url).href);
  const now = Date.parse("2026-11-24T10:00:00Z");
  const card = (id: string, status: string, extra: object = {}) => ({ id: `${id}-0000-0000`, title: `${id} card`, status, attempts: 1, ...extra });
  const cards = [
    card("parent", "ready"),
    card("blocked", "ready", { blocked: true, dependsOn: ["parent-0000-0000"] }),
    card("quiet", "running", { lastActivityAt: "2026-11-24T09:50:00Z" }),
    card("busy", "running", { lastActivityAt: "2026-11-24T09:59:30Z", live: { tool: "bash", turn: 4, since: "" } }),
    card("mine", "review", { prNumber: 12, prState: "OPEN", prChecks: "passing", reviewAction: "pr_ready" }),
    card("agent", "review", { reviewWait: "agent_review", reviewQueue: { position: 2, of: 3 } }),
    card("broken", "failed", { failureSummary: "Timed out: bash ran 31 min", attempts: 3 }),
    card("cut", "interrupted"),
    ...Array.from({ length: 7 }, (_, i) => card(`done${i}`, "done", { updatedAt: `2026-11-0${i + 1}` })),
    card("old", "archived"),
  ];
  const strip = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[\d;]*m/g, "")).join("\n");
  const text = strip(renderBoard(cards, { width: 120, now }));
  assert.match(text, /^Triage 0 {2}· {2}Ready 2 {2}· {2}Running 2 {2}· {2}Review 2 {2}· {2}Failed 2 {2}· {2}Done 7$/m);
  assert.doesNotMatch(text, /▍Triage|old card|▍Archive/);
  assert.match(text, /blocked- {2}blocked card {2}waiting on 1/);
  assert.match(text, /quiet-00 {2}quiet card {2}quiet 10m/);
  assert.match(text, /busy-000 {2}busy card {2}bash · turn 4/);
  assert.match(text, /mine-000 {2}mine card {2}PR #12 · passing · PR ready/);
  assert.match(text, /agent-00 {2}agent card {2}Waiting for agent review \(#2 of 3\)/);
  assert.match(text, /▍Failed 2\n {2}broken-0 {2}broken card {2}Timed out: bash ran 31 min · 3 attempts\n {2}cut-0000 {2}cut card {2}interrupted/);
  assert.match(text, /done6-00[^\n]*\n(.*\n){4} {2}… 2 more \(--all\)/);
  assert.doesNotMatch(text, /done0 card/, "the oldest Done cards are left out");
  const everything = strip(renderBoard(cards, { width: 120, now, all: true }));
  assert.match(everything, /▍Archive 1\n {2}old-0000 {2}old card/);
  assert.match(everything, /done0 card/);
  const narrow = strip(renderBoard([card("long", "ready", { title: "x".repeat(200) })], { width: 60, now }));
  assert.ok(narrow.split("\n").every(line => line.length <= 60), narrow);
});

test("cards --all and --watch are cards-only, and --watch needs a terminal", async () => {
  const f = await fixture();
  try {
    const piped = await f.run("cards", "--watch");
    assert.equal(piped.code, 1);
    assert.match(piped.stderr, /--watch needs a terminal/);
    const elsewhere = await f.run("stats", "--all");
    assert.match(elsewhere.stderr, /--all and --watch are only valid with cards/);
    const all = await f.run("cards", "--all");
    assert.equal(all.code, 0);
    assert.match(all.stdout, /^card-one\ttriage\t/m, "piped output keeps the tab-separated lines");
  } finally { await f.close(); }
});
