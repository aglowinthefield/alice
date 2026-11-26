import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain .mjs module without types
import { cardActions, createTui, keyNames } from "../scripts/cli-tui.mjs";
// @ts-expect-error plain .mjs module without types
import { width } from "../scripts/cli-screen.mjs";

type Call = [string, string, unknown?];
const board = { id: "b1", repo: "/repo", integration: "local", autoPickupEnabled: false };
const card = (id: string, status: string, extra: object = {}) => ({ id: `${id}-0000`, title: `${id} card`, status, attempts: 1, ...extra });

type Options = { board?: object; review?: object; fail?: string; flags?: object[]; columns?: number; rows?: number; boards?: object[]; conflicts?: object[]; byBoard?: Record<string, object[]>; today?: boolean };
function fixture(cards: object[], options: Options = {}) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const api = async (method: string, path: string, input?: unknown) => {
    calls.push([method, path, input]);
    if (options.fail && path.endsWith(options.fail)) throw new Error("Bakery 409: Card is already running");
    if (path === "/api/boards") return options.boards ?? {};
    if (path.endsWith("/conflicts")) return path.startsWith("/api/boards/b1/") ? options.conflicts ?? [] : [];
    const boardCards = /^\/api\/boards\/([\w-]+)\/cards$/.exec(path);
    if (boardCards) return options.byBoard?.[boardCards[1]] ?? cards;
    if (path === "/api/cards") return cards;
    if (path.endsWith("/ready-check") && options.flags) return { flags: options.flags };
    if (path.endsWith("/review")) return options.review ?? { files: [{ path: "a.ts" }], fingerprint: "f".repeat(64) };
    if (path.endsWith("/runs")) return [{ attempt: 2, status: "failed", agent: "pi", error: "Pi exited (143); Bakery sent SIGTERM: 60-minute run timeout", report: null }];
    return {};
  };
  const tui = createTui({ api, board: { ...board, ...options.board }, size: () => ({ columns: options.columns ?? 100, rows: options.rows ?? 12 }), open: (url: string) => opened.push(url), today: options.today, webUrl: (id: string, boardId: string) => `http://bakery/board/${boardId}/card/${id}`, now: () => Date.parse("2026-11-24T10:00:00Z") });
  const posts = () => calls.filter(([method]) => method === "POST");
  const screen = () => tui.render().map((line: string) => line.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "")).join("\n");
  return { tui, calls, posts, opened, screen };
}

test("keys split out of one chunk of terminal input", () => {
  assert.deepEqual(keyNames("jj\r"), ["j", "j", "enter"]);
  assert.deepEqual(keyNames("\x1b[A\x1b[Bq"), ["up", "down", "q"]);
  assert.deepEqual(keyNames("\x1b"), ["escape"]);
  assert.deepEqual(keyNames("\x03"), ["interrupt"]);
  assert.deepEqual(keyNames("\t]"), ["tab", "]"]);
});

test("a card offers the web card's actions for its state", () => {
  const keys = (item: object, extra: object = {}) => cardActions(item, { ...board, ...extra }).map((action: { key: string; label: string }) => `${action.key}:${action.label}`);
  assert.deepEqual(keys(card("t", "triage", { attempts: 0 })), ["r:ready"]);
  assert.deepEqual(keys(card("r", "ready", { attempts: 0 })), ["t:triage", "s:start"]);
  assert.deepEqual(keys(card("w", "ready", { attempts: 0, blocked: true })), ["t:triage"], "a waiting card cannot start");
  assert.deepEqual(keys(card("f", "failed")), ["s:run again", "R:recover"]);
  assert.deepEqual(keys(card("run", "running")), ["x:stop"]);
  assert.deepEqual(keys(card("mine", "review")), ["s:run again", "a:approve and merge"]);
  assert.deepEqual(keys(card("agent", "review", { reviewWait: "agent_review" })), [], "nothing while an agent has the card");
  assert.deepEqual(keys(card("pr", "review", { prState: "OPEN", prNumber: 7 }), { integration: "github-pr" }), ["s:run again", "a:approve, update PR #7"]);
  assert.deepEqual(keys(card("acc", "review", { reviewAction: "accept_findings" })), ["s:run again", "a:accept findings"]);
});

test("paid runs ask first; only y goes ahead", async () => {
  const f = fixture([card("f", "failed")]);
  await f.tui.refresh();
  await f.tui.key("s");
  assert.match(f.screen(), /Start a paid Pi run on “f card”\? .* y\/N/);
  await f.tui.key("n");
  assert.equal(f.posts().length, 0);
  assert.match(f.screen(), /Cancelled/);
  await f.tui.key("s");
  await f.tui.key("y");
  assert.deepEqual(f.posts(), [["POST", "/api/boards/b1/cards/f-0000/start", undefined]]);
  await f.tui.key("R");
  await f.tui.key("y");
  assert.deepEqual(f.posts()[1], ["POST", "/api/boards/b1/cards/f-0000/recover", undefined]);
});

test("Ready on a flagged card lists the flags and moves only on y", async () => {
  const flags = [{ rule: "person-only", message: "Needs a physical device, which the agent does not have" }];
  const f = fixture([card("t", "triage", { attempts: 0 })], { flags });
  await f.tui.refresh();
  await f.tui.key("r");
  assert.equal(f.posts().length, 0);
  assert.match(f.screen(), /may need another pass: Needs a physical device/);
  await f.tui.key("n");
  assert.equal(f.posts().length, 0, "n leaves the card in Triage");
  await f.tui.key("r");
  await f.tui.key("y");
  assert.deepEqual(f.posts(), [["POST", "/api/boards/b1/cards/t-0000/status", { status: "ready" }]]);
});

test("Ready goes straight through, even with pickup on; stop asks", async () => {
  const pickup = fixture([card("t", "triage", { attempts: 0 })], { board: { autoPickupEnabled: true } });
  await pickup.tui.refresh();
  await pickup.tui.key("r");
  assert.deepEqual(pickup.posts(), [["POST", "/api/boards/b1/cards/t-0000/status", { status: "ready" }]]);
  assert.doesNotMatch(pickup.screen(), /y\/N/);
  const running = fixture([card("run", "running")]);
  await running.tui.refresh();
  await running.tui.key("x");
  await running.tui.key("y");
  assert.deepEqual(running.posts(), [["POST", "/api/boards/b1/cards/run-0000/stop", undefined]]);
});

test("approve reads the review: findings, a new PR in the browser, an open PR, or a local merge", async () => {
  const fingerprint = "f".repeat(64);
  const findings = fixture([card("m", "review")], { review: { files: [], fingerprint } });
  await findings.tui.refresh();
  await findings.tui.key("a");
  assert.match(findings.screen(), /Accept the findings/);
  await findings.tui.key("y");
  assert.deepEqual(findings.posts(), [["POST", "/api/boards/b1/cards/m-0000/accept-findings", { fingerprint }]]);

  const newPr = fixture([card("m", "review")], { board: { integration: "github-pr" } });
  await newPr.tui.refresh();
  await newPr.tui.key("a");
  assert.equal(newPr.posts().length, 0);
  assert.match(newPr.screen(), /Press o to finish it in the browser/);
  await newPr.tui.key("o");
  assert.deepEqual(newPr.opened, ["http://bakery/board/b1/card/m-0000"]);

  const openPr = fixture([card("m", "review", { prState: "OPEN", prNumber: 9 })], { board: { integration: "github-pr" } });
  await openPr.tui.refresh();
  await openPr.tui.key("a");
  assert.match(openPr.screen(), /push them to PR #9/);
  await openPr.tui.key("y");
  assert.deepEqual(openPr.posts(), [["POST", "/api/boards/b1/cards/m-0000/approve", { fingerprint }]]);

  const local = fixture([card("m", "review")]);
  await local.tui.refresh();
  await local.tui.key("a");
  assert.match(local.screen(), /merge “m card” into local main/);
  await local.tui.key("y");
  assert.equal(local.posts().length, 1);
});

test("a refused action shows the server's reason", async () => {
  const f = fixture([card("f", "failed")], { fail: "/start" });
  await f.tui.refresh();
  await f.tui.key("s");
  await f.tui.key("y");
  assert.match(f.screen(), /Bakery 409: Card is already running/);
});

test("lanes sit side by side; j and k move within a lane, h and l between lanes", async () => {
  const cards = [...Array.from({ length: 6 }, (_, i) => card(`r0${i}`, "ready")), card("m", "review"), card("f", "failed")];
  const f = fixture(cards, { columns: 120, rows: 16 });
  await f.tui.refresh();
  const lines = f.tui.render();
  assert.equal(lines.length, 16, "the screen fills the terminal exactly");
  assert.match(f.screen(), /Ready +6 .*Review +1 .*Failed +1/, "the lanes share one header row");
  assert.match(f.screen(), /┃ ◎ r00 card/, "the first card is selected");
  await f.tui.key("j");
  assert.match(f.screen(), /┃ ◎ r01 card/);
  await f.tui.key("G");
  assert.match(f.screen(), /↑ \d more[\s\S]*┃ ◎ r05 card/, "the lane scrolls to keep the selected card on screen");
  await f.tui.key("l");
  assert.match(f.screen(), /┃ ◉ m card/);
  await f.tui.key("l");
  assert.match(f.screen(), /┃ ✗ f card/);
  await f.tui.key("h");
  await f.tui.key("h");
  assert.match(f.screen(), /┃ ◎ r05 card/, "a lane reopens on the card you last had there");
  await f.tui.key("q");
  assert.equal(f.tui.state.quit, true);
});

test("a tile shows its card's one live fact, and wide titles keep the grid aligned", async () => {
  const now = Date.parse("2026-11-24T10:00:00Z");
  const f = fixture([
    card("run", "running", { live: { tool: "bash", turn: 3, since: new Date(now).toISOString() }, lastActivityAt: new Date(now).toISOString() }),
    card("w", "ready", { title: "🍰 emoji 🍰 title 漢字", blocked: true, dependsOn: ["run-0000"] }),
    card("x", "failed", { failureSummary: "Timed out" }),
  ], { columns: 140 });
  await f.tui.refresh();
  assert.match(f.screen(), /bash · turn 3/);
  assert.match(f.screen(), /waiting on 1/);
  assert.match(f.screen(), /Timed out/);
  assert.equal(f.tui.animating(), true, "a running card animates its spinner");
  for (const line of f.tui.render()) assert.equal(width(line.replace(/\x1b\[[\d;]*m/g, "")), 140, line);
});

test("a pull request board splits Review like the web board", async () => {
  const f = fixture([card("a", "review", { reviewWait: "agent_review" }), card("g", "review", { reviewWait: "github" }), card("y", "review")], { board: { integration: "github-pr" }, columns: 160 });
  await f.tui.refresh();
  assert.match(f.screen(), /Review +1 .*Agent reviewing +1 .*Waiting on GitHub +1/);
});

test("enter opens the card as a dialog with its latest attempt; tab shows every attempt", async () => {
  const f = fixture([card("f", "failed", { body: "Goal: fix it.\n- run `npm test`", attachmentCount: 2 })], { rows: 24 });
  await f.tui.refresh();
  await f.tui.key("enter");
  const overview = f.screen();
  assert.match(overview, /✗ f card/);
  assert.match(overview, /• run npm test/, "the body's markdown keeps its bullets");
  assert.match(overview, /⇩ 2 attachments/);
  assert.match(overview, /Latest attempt +2 · failed/);
  assert.match(overview, /Pi exited \(143\); Bakery sent SIGTERM: 60-minute run timeout/);
  await f.tui.key("tab");
  assert.match(f.screen(), /Attempt 2 · failed · pi/);
  await f.tui.key("escape");
  assert.match(f.screen(), /┃ ✗ f card/);
});

test("a long question wraps instead of losing its y/N", async () => {
  const f = fixture([card("f", "failed", { title: "A card title long enough that the paid-run question runs past the edge of a narrow terminal" })], { columns: 60 });
  await f.tui.refresh();
  await f.tui.key("s");
  assert.match(f.screen(), /y\/N/);
});

test("the sidebar lists the boards; a number opens one, and the header shows its spend and conflicts", async () => {
  const boards = [
    { ...board, cost24h: 1.5, cardCounts: { review: 2, failed: 1 } },
    { id: "b2", repo: "/code/other", integration: "local", cost24h: 0.25, cardCounts: { running: 1 } },
  ];
  const f = fixture([card("a", "ready")], { boards, conflicts: [{ cardId: "x" }, { cardId: "y" }], byBoard: { b2: [card("z", "triage", { repo: "/code/other" })] }, columns: 150, rows: 14 });
  await f.tui.refresh();
  assert.match(f.screen(), /0 Today +3 /, "Today counts what needs you on every board");
  assert.match(f.screen(), /1 repo +2 /);
  assert.match(f.screen(), /2 other/);
  assert.match(f.screen(), /✗ 2 merge conflicts +\$1\.50 in 24h/);
  await f.tui.key("2");
  assert.match(f.screen(), /┃ ○ z card/);
  assert.match(f.screen(), /\$0\.25 in 24h/);
  assert.doesNotMatch(f.screen(), /merge conflict/, "the conflicts are the board's own");
  await f.tui.key("b");
  assert.doesNotMatch(f.screen(), /0 Today/, "b hides the sidebar");
});

test("Today lists what is running, what needs you and what is approved across boards, and acts on each card's board", async () => {
  const boards = [board, { id: "b2", repo: "/code/other", integration: "local" }];
  const all = [
    card("old", "review", { updatedAt: "2026-11-20T10:00:00Z" }),
    card("new", "review", { updatedAt: "2026-11-24T09:00:00Z", repo: "/code/other" }),
    card("burnt", "failed", { updatedAt: "2026-11-19T10:00:00Z", failureSummary: "Timed out" }),
    card("ok", "review", { reviewAction: "agent_approved", updatedAt: "2026-11-23T10:00:00Z" }),
    card("run", "running", { updatedAt: "2026-11-24T09:59:00Z" }),
    card("t", "triage", { updatedAt: "2026-11-24T09:00:00Z" }),
  ].map(item => ({ repo: "/repo", ...item }));
  const f = fixture(all, { boards, today: true, columns: 120, rows: 20 });
  await f.tui.refresh();
  const lines = f.screen().split("\n").map((line: string) => line.trim());
  const order = ["Running", "◐ run card", "Needs you", "◉ old card", "◉ new card", "✗ burnt card", "Approved, only your Approve is left", "◉ ok card"];
  assert.deepEqual(order.map(text => lines.findIndex((line: string) => line.startsWith(text) || line.startsWith(`▸ ${text}`))).every((at, i, list) => at >= 0 && (!i || at > list[i - 1])), true, f.screen());
  assert.doesNotMatch(f.screen(), /\bt card/, "Triage stays on its board");
  assert.match(f.screen(), /3 need you/);
  await f.tui.key("j");
  await f.tui.key("j");
  assert.match(f.screen(), /▸ ◉ new card/);
  await f.tui.key("enter");
  assert.deepEqual(f.calls.at(-1), ["GET", "/api/boards/b2/cards/new-0000/runs", undefined], "the dialog reads the card's own board");
  await f.tui.key("escape");
  await f.tui.key("s");
  await f.tui.key("y");
  assert.deepEqual(f.posts(), [["POST", "/api/boards/b2/cards/new-0000/start", undefined]]);
  await f.tui.key("0");
  assert.match(f.screen(), /repo +1 triage/, "0 goes back to the board");
});
