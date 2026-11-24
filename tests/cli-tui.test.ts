import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain .mjs module without types
import { cardActions, clipAnsi, createTui, keyNames } from "../scripts/cli-tui.mjs";

type Call = [string, string, unknown?];
const board = { id: "b1", repo: "/repo", integration: "local", autoPickupEnabled: false };
const card = (id: string, status: string, extra: object = {}) => ({ id: `${id}-0000`, title: `${id} card`, status, attempts: 1, ...extra });

function fixture(cards: object[], options: { board?: object; review?: object; fail?: string } = {}) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const api = async (method: string, path: string, input?: unknown) => {
    calls.push([method, path, input]);
    if (options.fail && path.endsWith(options.fail)) throw new Error("Bakery 409: Card is already running");
    if (path.endsWith("/cards")) return cards;
    if (path.endsWith("/review")) return options.review ?? { files: [{ path: "a.ts" }], fingerprint: "f".repeat(64) };
    if (path.endsWith("/runs")) return [{ attempt: 2, status: "failed", agent: "pi", error: "Pi exited (143); Bakery sent SIGTERM: 60-minute run timeout", report: null }];
    return {};
  };
  const tui = createTui({ api, board: { ...board, ...options.board }, size: () => ({ columns: 100, rows: 12 }), open: (url: string) => opened.push(url), webUrl: (id: string) => `http://bakery/card/${id}`, now: () => Date.parse("2026-11-24T10:00:00Z") });
  const posts = () => calls.filter(([method]) => method === "POST");
  const screen = () => tui.render().map((line: string) => line.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "")).join("\n");
  return { tui, calls, posts, opened, screen };
}

test("keys split out of one chunk of terminal input", () => {
  assert.deepEqual(keyNames("jj\r"), ["j", "j", "enter"]);
  assert.deepEqual(keyNames("\x1b[A\x1b[Bq"), ["up", "down", "q"]);
  assert.deepEqual(keyNames("\x1b"), ["escape"]);
  assert.deepEqual(keyNames("\x03"), ["interrupt"]);
  assert.equal(clipAnsi("\x1b[31mabcdef\x1b[0m", 3), "\x1b[31mabc\x1b[0m");
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

test("Ready asks only when pickup could start it; Triage and stop go through", async () => {
  const quiet = fixture([card("t", "triage", { attempts: 0 })]);
  await quiet.tui.refresh();
  await quiet.tui.key("r");
  assert.deepEqual(quiet.posts(), [["POST", "/api/boards/b1/cards/t-0000/status", { status: "ready" }]]);
  const pickup = fixture([card("t", "triage", { attempts: 0 })], { board: { autoPickupEnabled: true } });
  await pickup.tui.refresh();
  await pickup.tui.key("r");
  assert.equal(pickup.posts().length, 0);
  assert.match(pickup.screen(), /Pickup is on/);
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
  assert.deepEqual(newPr.opened, ["http://bakery/card/m-0000"]);

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

test("the selection scrolls into view, lanes jump, and details show the latest attempt", async () => {
  const cards = [...Array.from({ length: 15 }, (_, i) => card(`r${String(i).padStart(2, "0")}`, "ready")), card("f", "failed")];
  const f = fixture(cards);
  await f.tui.refresh();
  assert.equal(f.tui.render().length, 12, "the screen fills the terminal exactly");
  assert.match(f.screen(), /▸ r00-0000/);
  await f.tui.key("l");
  assert.match(f.screen(), /▸ f-0000 {2}f card/, "the selected card scrolled into view");
  await f.tui.key("h");
  assert.match(f.screen(), /▸ r00-0000/);
  await f.tui.key("G");
  await f.tui.key("enter");
  const details = f.screen();
  assert.match(details, /f card\nf-0000 · failed/);
  assert.match(details, /Attempt 2 · failed · pi\nPi exited \(143\); Bakery sent SIGTERM: 60-minute run timeout/);
  await f.tui.key("escape");
  assert.match(f.screen(), /▸ f-0000/);
  await f.tui.key("q");
  assert.equal(f.tui.state.quit, true);
});
