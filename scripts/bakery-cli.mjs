#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { doctor, report } from "./doctor.mjs";
import { commandHelp, overview, suggest, usageLine } from "./cli-help.mjs";
import { c, columns, layout, paint, pretty } from "./cli-style.mjs";
import { renderBoard } from "./cli-board.mjs";
import { ACTIONS as SERVICE_ACTIONS, service } from "./service.mjs";
import { openUrl, runTui } from "./cli-tui.mjs";
import { formatVersion, readVersion } from "./version.mjs";


function options(argv) {
  const result = { positionals: [], json: false, yes: false, after: [], on: [] };
  // These may repeat; each occurrence adds one card ID.
  const lists = new Set(["after", "on"]);
  const values = new Set(["board", "title", "body", "key", "priority", "concurrency", "limit", "budget", "integration", "host", "reason", "note"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--yes" || arg === "--all" || arg === "--watch" || arg === "--print") result[arg.slice(2)] = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--version" || arg === "-v") result.version = true;
    else if (arg.startsWith("--") && lists.has(arg.slice(2))) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Supply a card ID after ${arg}`);
      result[arg.slice(2)].push(argv[++i]);
    } else if (arg.startsWith("--") && values.has(arg.slice(2))) {
      const key = arg.slice(2);
      // Only --body may be empty, so edit can clear a description.
      const value = argv[i + 1];
      if (key in result || value === undefined || (!value && key !== "body") || value.startsWith("--")) throw new Error(`Supply exactly one value for ${arg}`);
      result[key] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else result.positionals.push(arg);
  }
  return result;
}

// BAKERY_URL may omit the scheme (HTTPS is tried first, then HTTP) and the port (4317).
async function serverUrl() {
  const raw = (process.env.BAKERY_URL ?? `http://127.0.0.1:${process.env.BAKERY_PORT ?? "4317"}`).trim();
  const invalid = new Error("BAKERY_URL must be a loopback server origin (for example 127.0.0.1:4317); set BAKERY_ALLOW_REMOTE=1 to allow another host");
  const parse = text => {
    let url;
    try { url = new URL(text); } catch { throw invalid; }
    if (!["http:", "https:"].includes(url.protocol) || (process.env.BAKERY_ALLOW_REMOTE !== "1" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw invalid;
    return url;
  };
  if (raw.includes("://")) return parse(raw);
  // A non-special scheme keeps the port exactly as typed, so ":443" is not mistaken for no port.
  let typedPort = "";
  try { typedPort = new URL(`bakery://${raw}`).port; } catch { throw invalid; }
  const candidates = ["https", "http"].map(scheme => {
    const url = parse(`${scheme}://${raw}`);
    if (!typedPort) url.port = "4317";
    return url;
  });
  const answers = await Promise.all(candidates.map(url => fetch(new URL("/api/status", url), { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false)));
  // Any HTTP answer, even a 403, means the scheme is right; request() reports the real error.
  return candidates[answers.indexOf(true)] ?? candidates[1];
}

async function request(origin, path, method = "GET", input, timeoutMs = 10000) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      headers: input === undefined ? undefined : { "Content-Type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Cannot reach Bakery at ${origin.origin}: ${error instanceof Error ? error.message : error}`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Bakery ${response.status}: ${data?.error ?? response.statusText}`);
  return data;
}

function selectBoard(boards, selector) {
  // The innermost repository containing the current directory wins, so nested repositories pick themselves.
  const cwd = process.cwd();
  const here = boards.filter(item => cwd === item.repo || cwd.startsWith(item.repo + sep)).sort((a, b) => b.repo.length - a.repo.length)[0];
  if (!selector && here) return here;
  if (!selector && boards.length === 1) return boards[0];
  if (!selector) throw new Error(boards.length ? "More than one board; choose one with --board ID|PATH" : "No boards yet. Add one with bakery-cli board-add PATH, or in Bakery.");
  const path = /^~[\\/]/.test(selector) ? resolve(homedir(), selector.slice(2)) : resolve(selector);
  const matches = boards.filter(item => item.id === selector || item.repo === path);
  if (matches.length !== 1) throw new Error(`Board not found: ${selector}`);
  return matches[0];
}

/**
 * Prints what may make the card churn before it moves to Ready (asks only a person can meet, no acceptance criteria).
 * A flagged card needs --yes, the CLI's "Ready anyway"; with it the flags still go to stderr. Servers without the
 * check answer 404 and the move goes ahead as before.
 */
async function readyCheck(origin, boardPath, id, yes) {
  let flags;
  try { ({ flags } = await request(origin, `${boardPath}/cards/${id}/ready-check`)); }
  catch (error) { if (/^Bakery 404: Not found$/.test(error.message)) return; throw error; }
  if (!flags?.length) return;
  const lines = flags.map(flag => `  - ${flag.message}${flag.quote ? `: "${flag.quote}"` : ""}`).join("\n");
  if (!yes) throw new Error(`This card may need another pass before a run:\n${lines}\nEdit it (bakery-cli edit ${id} --body ...), or repeat with --yes to move it to Ready anyway.`);
  process.stderr.write(`bakery-cli: moving to Ready anyway:\n${lines}\n`);
}

function cardId(value) {
  if (!value || !/^[\w-]+$/.test(value)) throw new Error("A card ID (letters, numbers, - or _) is required");
  return value;
}

const usageKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"];
// Older attempts have null usage: they are unknown, not free.
function usageTotal(items) {
  const recorded = items.filter(item => typeof item.cost === "number");
  const total = Object.fromEntries(usageKeys.map(key => [key, recorded.length ? recorded.reduce((sum, item) => sum + (item[key] ?? 0), 0) : null]));
  return { ...total, incomplete: recorded.length < items.length };
}
// Mirrors server/board.ts cardPriorities; the API returns the stored integer.
const priorities = { low: -10, normal: 0, high: 50, urgent: 100 };
const priorityValue = value => Object.hasOwn(priorities, value) ? priorities[value] : /^-?\d+$/.test(String(value)) && Math.abs(Number(value)) <= 100 ? Number(value) : null;
const priorityName = value => Object.keys(priorities).find(key => priorities[key] === (value ?? 0)) ?? String(value ?? 0);
const money = cost => typeof cost !== "number" ? "—" : cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
const lanes = ["triage", "ready", "running", "review", "failed", "interrupted", "done", "archived"];
const pickupSummary = item => `Pickup ${item.autoPickupEnabled ? "on" : "off"}; concurrency ${item.pickupConcurrency}; ${!item.limitsEnabled ? `limits off; ${item.autoPickupStarts ?? 0} starts in 24h` : item.pickupDailyLimit === 0 ? `${item.autoPickupStarts ?? 0} starts in 24h (no limit)` : `${item.autoPickupStarts ?? 0}/${item.pickupDailyLimit ?? 6} starts in 24h`}${item.autoPickupNextAt ? `; next slot ${item.autoPickupNextAt}` : ""}; ${money(item.cost24h ?? 0)} spent in 24h${item.limitsEnabled && typeof item.pickupCostBudget === "number" ? ` of ${money(item.pickupCostBudget)} budget${item.autoPickupBudgetReached ? " (waiting: budget reached)" : ""}` : ""}${item.autoPickupError ? `; paused: ${item.autoPickupError}` : ""}`;
const cardLine = card => `${card.id}\t${card.status}\t${card.title ?? ""}`;

// The API has no single-card GET, so find the card in its board's list.
async function findCard(origin, path, id) {
  const card = (await request(origin, `${path}/cards`)).find(item => item.id === id);
  if (!card) throw new Error(`Card not found on this board: ${id}`);
  return card;
}

const usageText = item => typeof item.cost !== "number" ? "—"
  : `${money(item.cost)} (${item.inputTokens ?? 0} in, ${item.outputTokens ?? 0} out, ${item.cacheReadTokens ?? 0} cache read, ${item.cacheWriteTokens ?? 0} cache write)`;

const imageTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Streams one local file to the card's attachment route. Fails with the file's path when it is missing or not a regular file. */
async function uploadAttachment(origin, base, file) {
  const path = resolve(file);
  let info;
  try { info = await stat(path); }
  catch (error) { throw new Error(`Cannot attach ${file}: ${error.code === "ENOENT" ? "no such file" : error.message}`); }
  if (!info.isFile()) throw new Error(`Cannot attach ${file}: not a regular file`);
  if (!info.size) throw new Error(`Cannot attach ${file}: the file is empty`);
  const type = imageTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
  let response;
  try {
    response = await fetch(new URL(`${base}?name=${encodeURIComponent(basename(path))}`, origin), {
      method: "POST", headers: { "Content-Type": type, "Content-Length": String(info.size) },
      body: Readable.toWeb(createReadStream(path)), duplex: "half",
    });
  } catch (error) {
    throw new Error(`Cannot reach Bakery at ${origin.origin}: ${error instanceof Error ? error.message : error}`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Bakery ${response.status}: ${data?.error ?? response.statusText}`);
  return data;
}

function print(data, json, lines) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else for (const line of pretty() ? layout(lines) : lines) console.log(line);
}

// Redraws on the terminal's alternate screen until Ctrl-C, keeping the last good board when a fetch fails.
async function watch(render) {
  const out = process.stdout;
  let last = [], problem = "";
  const leave = () => { out.write("\x1b[?25h\x1b[?1049l"); process.exit(0); };
  process.on("SIGINT", leave);
  out.write("\x1b[?1049h\x1b[?25l");
  for (;;) {
    try { last = await render(); problem = ""; } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    const footer = problem ? c.bad(problem) : c.dim(`updated ${new Date().toLocaleTimeString()} · Ctrl-C to quit`);
    const room = (out.rows || 24) - 1;
    out.write(`\x1b[H\x1b[2J${[...last.slice(0, room - 1), footer].join("\n")}`);
    await new Promise(done => setTimeout(done, 2000));
  }
}

// A usage mistake, so it exits 2 like other CLIs (house-style references/cli.md).
function unknown(name) {
  const near = suggest(name);
  return Object.assign(new Error(`Unknown command: ${name}.${near ? ` Did you mean ${near}?` : ""} Run bakery-cli help to see them all.`), { exitCode: 2 });
}

async function main() {
  const opts = options(process.argv.slice(2));
  const [command, ...args] = opts.positionals;
  if (opts.version) { console.log(`bakery-cli ${formatVersion(readVersion())}`); return; }
  if (!command || command === "help" && !args.length) { console.log(overview(formatVersion(readVersion()))); return; }
  if (opts.help || command === "help") {
    const name = command === "help" ? args[0] : command;
    const text = commandHelp(name);
    if (!text) throw unknown(name);
    console.log(text);
    return;
  }
  const variadic = ["start", "recover", "archive", "add", "purge-attachments", "attach"];
  const expected = { service: 1, doctor: 0, open: 0, limits: 0, agents: 0, board: 0, "board-add": 0, pr: 1, boards: 0, cards: 0, tui: 0, create: 0, ready: 1, triage: 1, runs: 1, conflicts: 0, sentinels: 0, "sentinel-pause": 1, "sentinel-resume": 1, "sentinel-run": 1, show: 1, edit: 1, restore: 1, close: 1, stats: 0, depend: 1, undepend: 1 };
  if (!(command in expected) && command !== "pickup" && !variadic.includes(command)) throw unknown(command);
  if ((command === "board" || command === "board-add" || command === "open") && args.length > 1 || command === "pr" && args.length > 2) throw new Error(`Invalid arguments for ${command}\n${usageLine(command)}`);
  if (command === "attach" && args.length < 2) throw new Error(`attach needs a card ID and at least one file\n${usageLine(command)}`);
  if (command === "board" || command === "board-add" || command === "open" ? false : command === "pr" ? !args.length : command === "pickup" ? args.length > 1 || (args.length === 1 && !["on", "off", "reset"].includes(args[0])) : command === "limits" ? args.length > 1 || (args.length === 1 && !["on", "off"].includes(args[0])) : command === "agents" ? args.length > 1 || (args.length === 1 && !/^(auto|\d{1,2})$/.test(args[0])) : variadic.includes(command) ? !args.length && command !== "add" : args.length !== expected[command]) throw new Error(`Invalid arguments for ${command}\n${usageLine(command)}`);
  if (command === "add" && opts.title !== undefined) throw new Error("add takes its title as words, not --title");
  if (!["create", "edit", "add"].includes(command) && (opts.title !== undefined || opts.body !== undefined)) throw new Error("--title and --body are only valid with create, add or edit");
  if (command !== "create" && command !== "add" && (opts.key !== undefined || opts.priority !== undefined)) throw new Error("--key and --priority are only valid with create or add");
  if (opts.priority !== undefined && priorityValue(opts.priority) === null) throw new Error("Priority must be a whole number from -100 to 100, or low, normal, high, or urgent");
  if (command !== "close" && (opts.reason !== undefined || opts.note !== undefined)) throw new Error("--reason and --note are only valid with close");
  if (opts.note !== undefined && opts.reason === undefined) throw new Error("--note needs --reason; use --reason other for free text");
  // "wrong approach" and "Wrong_Approach" both mean wrong-approach; the server rejects anything outside its list.
  const closeReason = opts.reason?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (opts.reason !== undefined && !closeReason) throw new Error("--reason cannot be empty; leave it out to close without a reason");
  if (command === "edit" && opts.title === undefined && opts.body === undefined) throw new Error("edit requires --title TITLE and/or --body BODY");
  if (command === "edit" && opts.title !== undefined && !opts.title.trim()) throw new Error("--title cannot be empty");
  if (opts.integration !== undefined && command !== "board") throw new Error("--integration is only valid with board");
  if (opts.integration !== undefined && !["local", "github-pr"].includes(opts.integration)) throw new Error("Integration must be local or github-pr");
  if (command === "board" && args.length && opts.board) throw new Error("Name the board once, as ID|PATH or with --board");
  if (command === "pr") cardId(args[0]);
  if (["show", "edit", "archive", "purge-attachments", "close", "restore", "depend", "undepend"].includes(command)) args.forEach(cardId);
  if (command === "attach") cardId(args[0]);
  if ((opts.all || opts.watch) && command !== "cards") throw new Error("--all and --watch are only valid with cards");
  if (opts.print && command !== "open") throw new Error("--print is only valid with open");
  if (command === "tui" && (opts.json || !process.stdout.isTTY || !process.stdin.isTTY)) throw new Error("tui needs a terminal and no --json; use cards for a pipe");
  if (opts.watch && (opts.json || !process.stdout.isTTY)) throw new Error("--watch needs a terminal and no --json");
  if (opts.after.length && command !== "create") throw new Error("--after is only valid with create");
  if (opts.on.length && command !== "depend" && command !== "undepend") throw new Error("--on is only valid with depend or undepend");
  if ((command === "depend" || command === "undepend") && !opts.on.length) throw new Error(`${command} requires --on CARD_ID`);
  [...opts.after, ...opts.on].forEach(cardId);
  if (command !== "pickup" && (opts.concurrency !== undefined || opts.limit !== undefined || opts.budget !== undefined)) throw new Error("--concurrency, --limit and --budget are only valid with pickup");
  if (opts.yes && !(command === "ready" || command === "pickup" || command === "start" || command === "recover" || command === "purge-attachments" || command === "service")) throw new Error("--yes is only valid with ready, start, recover, pickup, purge-attachments or service");
  if (opts.host !== undefined && !(command === "service" && args[0] === "install")) throw new Error("--host is only valid with service install");
  if (command === "service") {
    if (!SERVICE_ACTIONS.includes(args[0])) throw new Error(`Unknown service action: ${args[0]}. Use one of ${SERVICE_ACTIONS.join(", ")}.\n${usageLine(command)}`);
    if (opts.board || opts.json) throw new Error("--board and --json are not valid with service");
    // The server may not be running yet, so this never contacts it.
    service(args[0], { host: opts.host, yes: opts.yes });
    return;
  }
  if (command === "purge-attachments" && !opts.yes) throw new Error("Purging deletes the attached files from disk and cannot be undone, even if the card is restored. Repeat with --yes to confirm.");
  if (command === "recover" && args.length !== 1) throw new Error(`Invalid arguments for ${command}\n${usageLine(command)}`);
  if (command === "start" || command === "recover") {
    args.forEach(cardId);
    if (!opts.yes) throw new Error(`Starting ${args.length === 1 ? "a run" : `${args.length} runs`} uses paid Pi. Repeat with --yes to confirm.`);
  }
  const origin = await serverUrl();
  if (command === "doctor") {
    if (opts.board) throw new Error("--board is not valid with doctor");
    const checks = await doctor({ origin, local: ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), fetchBoards: () => request(origin, "/api/boards"), fetchStatus: () => request(origin, "/api/status"), fetchSettings: () => request(origin, "/api/settings"), cliVersion: readVersion(), cliPath: fileURLToPath(import.meta.url) });
    print(checks, opts.json, report(checks));
    // Failed check names go to the server's opt-in telemetry, which counts them only when the operator turned it on.
    // Best effort: not awaited, and abandoned after a second, so a slow or stalled route never delays the exit or changes its status.
    const failed = checks.filter(check => check.status === "fail").map(check => check.name);
    if (failed.length) request(origin, "/api/telemetry/doctor", "POST", { checks: failed }, 1000).catch(() => {});
    if (checks.some(check => check.status === "fail")) process.exitCode = 1;
    return;
  }
  if (command === "board-add") {
    if (opts.board) throw new Error("Name the repository as PATH, not --board");
    // The server resolves PATH to its git root and refuses a repository that already has a board.
    const added = await request(origin, "/api/boards", "POST", { repo: resolve(args[0] ?? process.cwd()) });
    print(added, opts.json, [`${added.id}\t${added.repo}`]);
    return;
  }
  if (command === "agents") {
    if (opts.board) throw new Error("--board is not valid with agents; the limit covers every board");
    const settings = args.length ? await request(origin, "/api/settings", "PATCH", { maxActiveAgents: args[0] === "auto" ? 0 : Number(args[0]) }) : await request(origin, "/api/settings");
    print({ maxActiveAgents: settings.maxActiveAgents, limit: settings.activeAgentsLimit, active: settings.activeAgents }, opts.json,
      [`Agents at once, all boards: ${settings.activeAgentsLimit}${settings.maxActiveAgents ? "" : " (automatic)"}; ${settings.activeAgents} running now. Automatic work waits for a slot; runs you start always start.`]);
    return;
  }
  const boards = await request(origin, "/api/boards");
  if (command === "boards") {
    if (opts.board) throw new Error("--board is not valid with boards");
    print(boards, opts.json, boards.map(item => `${item.id}\t${item.repo}\tpickup:${item.autoPickupEnabled ? "on" : "off"}\treview:${item.autoReviewEnabled ? "on" : "off"}${item.autoPickupError ? `\tpaused:${item.autoPickupError}` : ""}`));
    return;
  }
  if (command === "open") {
    if (args.length) cardId(args[0]);
    // With no card and no board to pick, open Bakery's home page rather than failing.
    const target = !args.length && !opts.board && boards.length > 1 && !boards.some(item => process.cwd() === item.repo || process.cwd().startsWith(item.repo + sep)) ? null : selectBoard(boards, opts.board);
    let route = "/";
    if (target) {
      route = `/board/${encodeURIComponent(target.id)}`;
      if (args.length) {
        // The CLI prints 8-character ids, so a unique prefix is enough.
        const found = (await request(origin, `/api/boards/${encodeURIComponent(target.id)}/cards`)).filter(item => item.id === args[0] || item.id.startsWith(args[0]));
        if (found.length !== 1) throw new Error(found.length ? `More than one card starts with ${args[0]}; give more of the ID` : `Card not found on this board: ${args[0]}`);
        route += `/card/${encodeURIComponent(found[0].id)}`;
      }
    }
    const url = new URL(route, origin).href;
    const opened = !opts.print && openUrl(url);
    print({ url, opened }, opts.json, [opened || opts.print ? url : `${url}\t(no browser here; open it yourself)`]);
    return;
  }
  const board = selectBoard(boards, command === "board" && args.length ? args[0] : opts.board);
  const path = `/api/boards/${encodeURIComponent(board.id)}`;
  if (command === "tui") {
    return runTui({
      api: (method, route, input) => request(origin, route, method, input, 30_000),
      board, title: board.repo.replace(homedir(), "~"),
      webUrl: id => new URL(`/board/${encodeURIComponent(board.id)}/card/${encodeURIComponent(id)}`, origin).href,
    });
  }
  if (command === "cards") {
    const draw = cards => renderBoard(cards, { width: columns(), all: opts.all, title: board.repo.replace(homedir(), "~") });
    if (opts.watch) return watch(() => request(origin, `${path}/cards`).then(draw));
    const cards = await request(origin, `${path}/cards`);
    if (pretty() && !opts.json) for (const line of draw(cards)) console.log(line);
    else print(cards, opts.json, cards.map(item => `${item.id}\t${item.status}\tpriority:${priorityName(item.priority)}\tattempts:${item.attempts ?? 0}\treview-rounds:${item.reviewRounds ?? 0}\t${item.title}`));
  } else if (command === "create" || command === "add") {
    if (command === "add") opts.title = args.join(" ");
    if (!opts.title?.trim()) throw new Error(command === "add" ? "add requires a title" : "create requires --title TITLE");
    if (opts.key !== undefined && (!opts.key.trim() || opts.key.length > 200)) throw new Error("--key must be 1 to 200 characters");
    const input = { title: opts.title, body: opts.body ?? "" };
    if (opts.priority !== undefined) input.priority = Object.hasOwn(priorities, opts.priority) ? opts.priority : Number(opts.priority);
    if (opts.key !== undefined) input.idempotencyKey = opts.key;
    if (opts.after.length) input.dependsOn = opts.after;
    const card = await request(origin, `${path}/cards`, "POST", input);
    print(card, opts.json, [`${card.id}\t${card.status}\tpriority:${priorityName(card.priority)}\t${card.title}${card.dependsOn?.length ? `\tafter:${card.dependsOn.join(",")}` : ""}`]);
  } else if (command === "depend" || command === "undepend") {
    const id = args[0];
    let card;
    for (const other of opts.on) {
      card = command === "depend"
        ? await request(origin, `${path}/cards/${id}/dependencies`, "POST", { dependsOn: other })
        : await request(origin, `${path}/cards/${id}/dependencies/${other}`, "DELETE");
    }
    print(card, opts.json, [`${cardLine(card)}\tdepends on:${card.dependsOn?.length ? card.dependsOn.join(",") : "none"}${card.blocked ? "\tblocked" : ""}`]);
  } else if (command === "ready" || command === "triage") {
    if (command === "ready" && board.autoPickupEnabled && !opts.yes) throw new Error("Auto pickup is enabled: Ready may start paid Pi immediately. Repeat with --yes to confirm.");
    if (command === "ready") await readyCheck(origin, path, cardId(args[0]), opts.yes);
    const card = await request(origin, `${path}/cards/${cardId(args[0])}/status`, "POST", { status: command });
    print(card, opts.json, [`${card.id}\t${card.status}\t${card.title ?? ""}`]);
  } else if (command === "recover") {
    const run = await request(origin, `${path}/cards/${cardId(args[0])}/recover`, "POST");
    print({ cardId: args[0], run }, opts.json, [`${args[0]}\trecovery attempt #${run.attempt}\t${run.status}\tsession ${run.sessionId}`]);
  } else if (command === "start") {
    // Each card starts independently so one refusal does not block the others.
    const results = [];
    for (const id of args) {
      try { results.push({ cardId: id, run: await request(origin, `${path}/cards/${id}/start`, "POST") }); }
      catch (error) { results.push({ cardId: id, error: error instanceof Error ? error.message : String(error) }); }
    }
    print(results, opts.json, results.map(item => item.run ? `${item.cardId}\tattempt #${item.run.attempt}\t${item.run.status}` : `${item.cardId}\terror\t${item.error}`));
    if (results.some(item => item.error)) process.exitCode = 1;
  } else if (command === "runs") {
    const id = cardId(args[0]);
    const runs = await request(origin, `${path}/cards/${id}/runs`);
    const reviews = await request(origin, `${path}/cards/${id}/auto-review`);
    const total = usageTotal([...runs, ...reviews]);
    print({ cardId: id, total, runs, reviews }, opts.json, [
      ...runs.map(run => `${run.id}\t${run.status}\t${run.startedBy ?? "manual"}\t${run.startedAt ?? ""}\t${run.agent || "-"}\t${usageText(run)}${run.error ? `\t${run.error}` : ""}`),
      ...reviews.map(job => `review ${job.runId}\t${job.state}\t${job.agent || "-"}\t${usageText(job)}`),
      `total\t${total.cost === null ? "—" : usageText(total)}${total.incomplete && total.cost !== null ? "\t(older attempts not recorded)" : ""}`,
    ]);
  } else if (command === "show") {
    const id = args[0];
    const card = await findCard(origin, path, id);
    const runs = await request(origin, `${path}/cards/${id}/runs`);
    const reviews = await request(origin, `${path}/cards/${id}/auto-review`);
    const dependencies = await request(origin, `${path}/cards/${id}/dependencies`);
    const review = reviews[0] ?? null;
    const refs = (label, items) => items.length ? items.map(item => `${label}\t${item.id}\t${item.status}\t${item.title}`) : [`${label}\tnone`];
    print({ card, runs, review, dependencies }, opts.json, [
      pretty() ? c.bold(card.title) : `${card.title}`,
      `id\t${card.id}`, `status\t${card.status}${card.blocked ? " (blocked: waiting on dependencies)" : ""}`, `repo\t${card.repo ?? board.repo}`,
      ...refs("depends on", dependencies.dependsOn), ...refs("dependent", dependencies.dependents),
      "", ...(card.body?.trim() ? card.body.split("\n") : ["(no description)"]), "",
      `attempts\t${runs.length}`,
      ...runs.map(run => `#${run.attempt}\t${run.status}\t${run.agent || "-"}${run.error ? `\t${run.error}` : ""}`),
      `auto-review\t${review ? `${review.state}${review.details ? `\t${review.details}` : ""}` : "none"}`,
    ]);
  } else if (command === "edit") {
    const id = args[0];
    // PATCH needs both fields, so keep whichever one was not supplied.
    const current = opts.title === undefined || opts.body === undefined ? await findCard(origin, path, id) : {};
    const card = await request(origin, `${path}/cards/${id}`, "PATCH", { title: opts.title ?? current.title, body: opts.body ?? current.body ?? "" });
    print(card, opts.json, [cardLine(card)]);
  } else if (command === "close") {
    const card = await request(origin, `${path}/cards/${args[0]}/close`, "POST", closeReason ? { reason: closeReason, ...(opts.note ? { note: opts.note } : {}) } : {});
    print(card, opts.json, [cardLine(card)]);
  } else if (command === "archive" || command === "restore") {
    const cards = await request(origin, `${path}/cards/${command === "archive" ? "archive" : "unarchive"}`, "POST", { cardIds: args });
    print(cards, opts.json, cards.map(cardLine));
  } else if (command === "attach") {
    const id = args[0];
    await findCard(origin, path, id);
    // One at a time, in order. Each saved file's line prints at once; a failure stops there and names the file, files
    // already saved stay attached, and --json still prints them before the error and nonzero exit.
    const saved = [];
    const link = item => `${/^image\/(png|jpeg|gif|webp)$/.test(item.type) ? "!" : ""}[${item.name.replace(/[[\]]/g, "_")}](${path}/cards/${id}/attachments/${item.id})`;
    try {
      for (const file of args.slice(1)) {
        const item = await uploadAttachment(origin, `${path}/cards/${id}/attachments`, file);
        saved.push(item);
        if (!opts.json) console.log(link(item));
      }
    } catch (error) {
      if (opts.json && saved.length) console.log(JSON.stringify(saved, null, 2));
      throw error;
    }
    if (opts.json) console.log(JSON.stringify(saved, null, 2));
  } else if (command === "purge-attachments") {
    const purged = await request(origin, `${path}/cards/purge-attachments`, "POST", { cardIds: args });
    print(purged, opts.json, purged.map(item => `${item.cardId}\tpurged ${item.files} file${item.files === 1 ? "" : "s"}, ${item.bytes} bytes`));
  } else if (command === "stats") {
    const counts = Object.fromEntries(lanes.map(lane => [lane, board.cardCounts?.[lane] ?? 0]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const pickup = Object.fromEntries(["autoPickupEnabled", "pickupConcurrency", "pickupDailyLimit", "autoPickupStarts", "autoPickupNextAt", "cost24h", "pickupCostBudget", "autoPickupBudgetReached", "autoPickupError"]
      .filter(key => key in board).map(key => [key, board[key]]));
    print({ boardId: board.id, repo: board.repo, counts, total, pickup }, opts.json, [
      ...lanes.map(lane => `${lane}\t${counts[lane]}`), `total\t${total}`, pickupSummary(board),
    ]);
  } else if (command === "board") {
    let updated = board;
    if (opts.integration !== undefined) updated = await request(origin, `${path}/settings`, "PATCH", { integration: opts.integration });
    print(updated, opts.json, [`${updated.id}\t${updated.repo}\tintegration:${updated.integration ?? "local"}\treview:${updated.autoReviewEnabled ? "on" : "off"}${updated.remoteUrl ? `\tremote:${updated.remoteUrl}` : ""}${updated.integrationError ? `\terror:${updated.integrationError}` : ""}`]);
  } else if (command === "pr") {
    const card = args.length === 1 ? await findCard(origin, path, args[0])
      : await request(origin, `${path}/cards/${encodeURIComponent(args[0])}/pull-request`, "PUT", { url: args[1] === "off" ? "" : args[1] });
    print(card, opts.json, [`${card.id}\t${card.prUrl ?? "no pull request"}${card.prOverrideUrl ? "\t(linked)" : ""}${card.prState ? `\t${card.prState.toLowerCase()}` : ""}${card.prChecks ? `\tchecks:${card.prChecks}` : ""}${card.prError ? `\t${card.prError}` : ""}`]);
  } else if (command === "sentinels") {
    const sentinels = await request(origin, `${path}/sentinels`);
    print(sentinels, opts.json, sentinels.map(item => {
      const last = item.runs[0];
      return `${item.sentinel.id}\t${item.sentinel.kind}\t${item.sentinel.enabled ? "enabled" : "paused"}\tevery:${Math.round(item.sentinel.intervalMs / 1000)}s\tnext:${item.sentinel.enabled ? item.sentinel.nextRunAt : "-"}\tlast-run:${last ? `${last.status} ${last.startedAt}` : "none"}\tjobs:${item.jobs.length}`;
    }));
  } else if (command === "sentinel-pause" || command === "sentinel-resume" || command === "sentinel-run") {
    const id = encodeURIComponent(args[0]);
    const sentinels = await request(origin, `${path}/sentinels`);
    if (!sentinels.some(item => item.sentinel.id === args[0])) throw new Error(`Sentinel not found on this board: ${args[0]}`);
    const updated = command === "sentinel-run" ? await request(origin, `/api/sentinels/${id}/run`, "POST")
      : await request(origin, `/api/sentinels/${id}`, "PATCH", { enabled: command === "sentinel-resume" });
    print(updated, opts.json, [`${updated.id}\t${updated.kind}\t${updated.enabled ? "enabled" : "paused"}\tnext:${updated.nextRunAt}`]);
  } else if (command === "conflicts") {
    const conflicts = await request(origin, `${path}/conflicts`);
    print(conflicts, opts.json, conflicts.map(item => `${item.cardId}\t${item.details ?? ""}`));
  } else if (command === "limits") {
    const updated = args.length ? await request(origin, `${path}/settings`, "PATCH", { limitsEnabled: args[0] === "on" }) : board;
    const daily = updated.pickupDailyLimit === 0 ? "no daily start limit" : `${updated.pickupDailyLimit} starts per 24h`;
    const budget = typeof updated.pickupCostBudget === "number" ? `${money(updated.pickupCostBudget)} daily budget` : "no budget";
    const diff = updated.autoReviewMaxFiles || updated.autoReviewMaxPatchChars ? `review diffs up to ${updated.autoReviewMaxFiles || "any"} files / ${updated.autoReviewMaxPatchChars || "any"} characters` : "no review diff caps";
    print(updated, opts.json, [`Limits ${updated.limitsEnabled ? "on" : "off"}${updated.limitsEnabled ? "" : " (stored, not applied)"}: ${daily}; ${budget}; ${diff}. Concurrency ${updated.pickupConcurrency} runs, ${updated.autoReviewConcurrency ?? 1} reviews; loop guards always apply.`,
      ...await request(origin, "/api/settings").then(settings => typeof settings.activeAgentsLimit === "number" ? [`All boards: ${settings.activeAgents} of ${settings.activeAgentsLimit} agents running (bakery-cli agents).`] : [], () => [])]);
  } else if (command === "pickup") {
    const summary = pickupSummary;
    if (!args.length) { print(board, opts.json, [summary(board)]); return; }
    if (args[0] === "reset") {
      if (opts.concurrency !== undefined || opts.limit !== undefined || opts.budget !== undefined) throw new Error("pickup reset does not accept --concurrency, --limit or --budget");
      if (!opts.yes) throw new Error("Resetting the limit can start paid Pi runs immediately. Repeat with --yes to confirm.");
      const updated = await request(origin, `${path}/auto-pickup/reset-limit`, "POST");
      print(updated, opts.json, [summary(updated)]);
      return;
    }
    if (args[0] === "on" && !opts.yes) throw new Error("Enabling pickup can start paid Pi runs immediately. Repeat with --yes to confirm.");
    const concurrency = opts.concurrency === undefined ? board.pickupConcurrency : Number(opts.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Concurrency must be an integer from 1 to 4");
    const limit = opts.limit === undefined ? (board.pickupDailyLimit ?? 6) : opts.limit === "off" ? 0 : /^\d+$/.test(opts.limit) ? Number(opts.limit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 99) throw new Error("Limit must be off, 0 (no limit) or an integer from 1 to 99");
    const current = board.pickupDailyLimit ?? 6;
    if (args[0] === "on" && board.autoPickupEnabled && current !== 0 && (limit === 0 || limit > current) && !opts.yes)
      throw new Error("Raising the limit can start paid Pi runs immediately. Repeat with --yes to confirm.");
    const input = { autoPickupEnabled: args[0] === "on", pickupConcurrency: concurrency, pickupDailyLimit: limit };
    if (opts.budget !== undefined) {
      const budget = opts.budget === "off" ? null : Number(opts.budget.replace(/^\$/, ""));
      if (budget !== null && (!Number.isFinite(budget) || budget < 0.01 || budget > 10000)) throw new Error("Budget must be off or a USD amount from 0.01 to 10000");
      input.pickupCostBudget = budget;
    }
    const updated = await request(origin, `${path}/settings`, "PATCH", input);
    print(updated, opts.json, [summary(updated)]);
  }
}

main().catch(error => { console.error(`${paint("31", process.stderr)("bakery-cli:")} ${error instanceof Error ? error.message : error}`); process.exitCode = error?.exitCode ?? 1; });
