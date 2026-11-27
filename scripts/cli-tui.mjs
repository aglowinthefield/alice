// `alice tui`: the web app in the terminal, driven by keys. A sidebar lists the boards, a board's lanes sit side
// by side with a tile per card, Today gathers what needs you on every board, and Enter opens a card as a dialog.
// `createTui` holds the state and answers keys without touching the terminal, so tests drive it with a fake API;
// `runTui` wires it to a raw-mode TTY.
import { spawn } from "node:child_process";
import { cardActivity, needsYouStatuses, needsYourReview, reviewWaitText, searchRank, todaySections, waitingOn } from "../src/model.ts";
import { Screen, clip, width, wrap } from "./cli-screen.mjs";
import { useColor } from "./cli-style.mjs";

const KEYS = { "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down", "\x1b[C": "right", "\x1bOC": "right", "\x1b[D": "left", "\x1bOD": "left", "\r": "enter", "\n": "enter", "\t": "tab", "\x1b": "escape", "\x03": "interrupt", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x7f": "backspace", "\b": "backspace" };
export const keyName = data => KEYS[data] ?? data;
/** One chunk of terminal input as key names: fast typing and pastes arrive several keys at a time. */
export function keyNames(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const sequence = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[\d;]*[~A-Za-z]|\x1bO[A-D]|\r\n)/.exec(data.slice(i))?.[0] ?? data[i];
    // A mouse report (SGR mode) becomes "mouse:BUTTON:COLUMN:ROW:M", M for a press and m for a release.
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
    out.push(mouse ? `mouse:${mouse.slice(1).join(":")}` : keyName(sequence === "\r\n" ? "\r" : sequence));
    i += sequence.length;
  }
  return out;
}

/** What the selected card can do from the keyboard, mirroring the web card's buttons. */
export function cardActions(card, board) {
  if (!card) return [];
  const out = [], { status } = card;
  if (status === "triage") out.push({ key: "r", label: "ready", act: "ready" });
  if (status === "ready" && !card.attempts) out.push({ key: "t", label: "triage", act: "triage" });
  if (["ready", "failed", "review"].includes(status) && !card.startQueued && !(card.blocked && !card.attempts) && !(status === "review" && card.reviewWait))
    out.push({ key: "s", label: card.attempts ? "run again" : "start", act: "start" });
  if (status === "running") out.push({ key: "x", label: "stop", act: "stop" });
  if (needsYourReview(card)) {
    const pr = board.integration === "github-pr";
    out.push({
      key: "a", act: "approve",
      label: card.reviewAction === "accept_findings" ? "accept findings" : pr && card.prState === "OPEN" ? `approve, update PR #${card.prNumber}` : pr ? "open PR" : "approve and merge",
    });
  }
  if (status === "failed") out.push({ key: "R", label: "recover", act: "recover" });
  return out;
}

// SGR styles: the terminal's 16 colours, so the person's theme picks the shades. Yellow is Alice's accent.
const DIM = "2", ACCENT = "1;33";
// Pills with a background, as on the web: a failure reason, and Needs you.
const PILL_BAD = "41;97", PILL_YOU = "42;30";
/**
 * The web board's lanes. On a pull request board, Review holds only cards that need you; cards an agent still has
 * and cards waiting on GitHub get lanes of their own, as on the web.
 */
const LANES = [
  { id: "triage", label: "Triage", style: DIM, glyph: "○" },
  { id: "ready", label: "Ready", style: "36", glyph: "◎" },
  { id: "running", label: "Running", style: "33" },
  { id: "review", label: "Review", style: "34", glyph: "◉" },
  { id: "agent", label: "Agent reviewing", style: "35", glyph: "◆", split: true },
  { id: "waiting", label: "Waiting on GitHub", style: "34", glyph: "◇", split: true },
  { id: "failed", label: "Failed", style: "31", glyph: "✗" },
  { id: "done", label: "Done", style: "32", glyph: "✓" },
  { id: "archived", label: "Archive", style: DIM, glyph: "·" },
];
const SPINNER = ["◐", "◓", "◑", "◒"];
const laneOf = (card, split) =>
  card.status === "interrupted" ? "failed"
    : split && card.status === "review" && card.reviewWait ? (card.reviewWait === "github" ? "waiting" : "agent")
    : card.status;
const isPullRequestBoard = board => board.integration === "github-pr";
const nameOf = board => board.repo.split(/[\\/]/).pop();

/**
 * The one thing worth reading on a tile; everything else is in the card dialog. On a pull request board an agent's
 * review has its own lane, so the pill only adds the card's place in the queue.
 */
function tilePill(card, cards, now, split = false) {
  if (card.status === "running") {
    if (cardActivity(card, now) === "quiet") return [`quiet ${Math.round((now - Date.parse(card.lastActivityAt)) / 60_000)}m`, "33"];
    return [card.live ? `${card.live.tool} · turn ${card.live.turn}` : "starting", "33"];
  }
  if (card.status === "interrupted") return ["interrupted", "33"];
  if (card.status === "failed") return card.failureSummary ? [` ${card.failureSummary} `, PILL_BAD] : null;
  if (card.status === "review") {
    if (card.prChecks === "failing") return [`PR #${card.prNumber} failing`, "31"];
    return card.reviewWait && (!split || card.reviewQueue) ? [reviewWaitText(card), DIM] : null;
  }
  if (card.blocked) return [`waiting on ${waitingOn(card, cards).length}`, DIM];
  if (card.startQueued) return ["queued", "36"];
  if (card.status === "done" && card.originMain === "local") return ["not pushed", "33"];
  return null;
}

const HELP = [
  ["0", "Today: what needs you on every board"], ["1–9", "the board with that number in the sidebar"], ["b", "show or hide the sidebar"],
  ["← →  h l", "previous or next lane"], ["↑ ↓  j k", "move within a lane, or down Today"], ["g  G", "first or last card"],
  ["enter", "open the card (esc closes, tab switches to its attempts)"], ["o", "open the card in the browser"], ["A", "show or hide the Archive lane"],
  ["/", "find a card on this board by title or id, or on every board from Today"],
  ["click", "select a card, a board or a key in the footer; click a selected card to open it. The wheel scrolls"],
  ["r  t", "move to Ready or back to Triage"], ["s", "start or run again (asks first: paid)"], ["x", "stop a running agent"],
  ["a", "approve, accept findings, or update the PR"], ["R", "recover a Failed card in a fresh session"], ["q", "quit"],
];

export function createTui({ api, board, today = false, size = () => ({ columns: 80, rows: 24 }), open = () => {}, webUrl = cardId => cardId, now = () => Date.now(), color = false }) {
  const state = {
    board, boards: [board], view: today ? "today" : "board", cards: [], today: [], todayAt: 0, conflicts: 0, slowAt: -Infinity, sidebar: null,
    selected: null, all: false, mode: "board", confirm: null, message: "", error: false, details: null, tab: 0, scroll: 0, search: null,
    laneStart: 0, laneScroll: {}, lastInLane: {}, zones: [], quit: false,
  };
  const say = (message, error = false) => { state.message = message; state.error = error; };
  const pathOf = item => `/api/boards/${encodeURIComponent(item.id)}`;
  const boardOf = card => state.boards.find(item => item.repo === card.repo) ?? state.board;
  const split = () => isPullRequestBoard(state.board);
  const lanes = () => LANES.filter(lane => (split() || !lane.split) && (state.all || lane.id !== "archived"));
  const cardsIn = id => {
    const list = state.cards.filter(card => laneOf(card, split()) === id);
    return id === "done" || id === "archived" ? list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")) : list;
  };
  const since = () => new Date(now() - 86_400_000).toISOString();
  /** Today's rows: a heading per section, then its cards, in the web page's order. */
  function todayRows() {
    const { running, attention, approved } = todaySections(state.today, since());
    return [["Running", "33", running], ["Needs you", "1;34", attention], ["Approved, only your Approve is left", "32", approved]]
      .flatMap(([label, style, cards]) => cards.length ? [{ label, style }, ...cards.map(card => ({ card }))] : []);
  }
  const todayCards = () => todayRows().filter(row => row.card).map(row => row.card);
  const selectedOnBoard = () => state.cards.find(card => card.id === state.selected);
  /** The open dialog's card as of the latest refresh. */
  const shownCard = () => [...state.cards, ...state.today].find(item => item.id === state.details.card.id) ?? state.details.card;
  // A card found with / may be off the Today list, so the dialog's card, not the list's, is the one keys act on.
  const current = () => state.mode === "details" ? shownCard() : state.view === "today" ? todayCards()[state.todayAt] : selectedOnBoard();
  const laneOfSelected = () => { const card = selectedOnBoard(); return card && laneOf(card, split()); };
  const filled = () => lanes().filter(lane => cardsIn(lane.id).length);
  const showSidebar = () => state.sidebar ?? size().columns >= 140;

  function select(card) {
    if (!card) return;
    state.selected = card.id;
    state.lastInLane[laneOf(card, split())] = card.id;
  }

  async function refresh() {
    // The sidebar, spend and conflicts change slowly: they refresh every 30 seconds and keep their last value when a
    // fetch fails. Cards refresh every time.
    if (now() - state.slowAt >= 30_000) {
      state.slowAt = now();
      const [boards, conflicts] = await Promise.allSettled([api("GET", "/api/boards"), api("GET", `${pathOf(state.board)}/conflicts`)]);
      if (Array.isArray(boards.value) && boards.value.length) {
        state.boards = boards.value;
        state.board = boards.value.find(item => item.id === state.board.id) ?? state.board;
      }
      if (Array.isArray(conflicts.value)) state.conflicts = conflicts.value.length;
    }
    if (state.view === "today") {
      state.today = await api("GET", "/api/cards");
      state.todayAt = Math.max(0, Math.min(state.todayAt, todayCards().length - 1));
      return;
    }
    state.cards = await api("GET", `${pathOf(state.board)}/cards`);
    const card = selectedOnBoard();
    if (!card || !lanes().some(lane => lane.id === laneOf(card, split()))) select(cardsIn(filled()[0]?.id)[0]);
  }

  /** Switches to Today or to a board, starting that board fresh. */
  async function show(view, item = state.board) {
    if (item.id !== state.board.id)
      Object.assign(state, { board: item, cards: [], selected: null, laneStart: 0, laneScroll: {}, lastInLane: {}, conflicts: 0, slowAt: -Infinity });
    state.view = view;
    await refresh();
  }

  async function openDetails(card = current()) {
    if (!card) return;
    state.mode = "details"; state.tab = 0; state.scroll = 0; state.details = { card, runs: null };
    try { state.details.runs = await api("GET", `${pathOf(boardOf(card))}/cards/${card.id}/runs`); }
    catch (error) { say(error.message, true); }
  }

  const ask = (text, run) => { state.confirm = { text, run }; };
  // The card text check behind the web board's Ready dialog. A server without it answers 404, so nothing is flagged.
  async function readyFlags(base) {
    try { return (await api("GET", `${base}/ready-check`)).flags ?? []; }
    catch (error) { if (/^Alice 404: Not found$/.test(error.message)) return []; throw error; }
  }
  async function act(action, card) {
    const home = boardOf(card), base = `${pathOf(home)}/cards/${card.id}`;
    const quoted = `“${card.title.length > 50 ? `${card.title.slice(0, 49)}…` : card.title}”`;
    const done = message => async () => { await refresh(); say(message); };
    if (action === "ready") {
      const move = async () => { await api("POST", `${base}/status`, { status: "ready" }); await done(`Moved ${quoted} to Ready`)(); };
      // r moves the card straight to Ready. Only a card the web board's text check flags asks first: y is Ready
      // anyway; n leaves it in Triage, and o opens it to edit.
      const flags = await readyFlags(base);
      if (flags.length) ask(`${quoted} may need another pass: ${flags.map(flag => flag.message).join("; ")}. Move it to Ready anyway?`, move);
      else await move();
    } else if (action === "triage") {
      await api("POST", `${base}/status`, { status: "triage" }); await done(`Moved ${quoted} back to Triage`)();
    } else if (action === "start") {
      ask(`Start a paid Pi run on ${quoted}? It can edit the card's worktree.`, async () => { await api("POST", `${base}/start`); await done(`Started ${quoted}`)(); });
    } else if (action === "recover") {
      ask(`Recover ${quoted} in a fresh Pi session? This is a paid run.`, async () => { await api("POST", `${base}/recover`); await done(`Recovering ${quoted}`)(); });
    } else if (action === "stop") {
      ask(`Stop the agent on ${quoted}? Its worktree stays.`, async () => { await api("POST", `${base}/stop`); await done(`Stopped ${quoted}`)(); });
    } else if (action === "approve") {
      say("Loading the review…");
      const review = await api("GET", `${base}/review`);
      const fingerprint = review.fingerprint;
      say("");
      if (!review.files?.length)
        ask(`Accept the findings on ${quoted}? The run changed no files, so the card moves to Done.`, async () => { await api("POST", `${base}/accept-findings`, { fingerprint }); await done(`Accepted the findings on ${quoted}`)(); });
      else if (isPullRequestBoard(home) && card.prState !== "OPEN")
        say("A new pull request needs its title and body reviewed. Press o to finish it in the browser.");
      else if (isPullRequestBoard(home))
        ask(`Approve ${review.files.length} changed file(s) and push them to PR #${card.prNumber}? The card is Done once the PR merges.`, async () => { await api("POST", `${base}/approve`, { fingerprint }); await done(`Pushed ${quoted} to PR #${card.prNumber}`)(); });
      else
        ask(`Approve ${review.files.length} changed file(s) and merge ${quoted} into local main? Alice does not run tests or push.`, async () => { await api("POST", `${base}/approve`, { fingerprint }); await done(`Merged ${quoted} into local main`)(); });
    }
  }

  function move(delta) {
    if (state.view === "today") { state.todayAt = Math.max(0, Math.min(todayCards().length - 1, state.todayAt + delta)); return; }
    const list = cardsIn(laneOfSelected()), at = list.findIndex(card => card.id === state.selected);
    select(list[Math.max(0, Math.min(list.length - 1, at + delta))]);
  }
  /** The next lane with cards; it opens on the card you last had there. */
  function jumpLane(delta) {
    if (state.view === "today") return;
    const list = filled(), lane = list[list.findIndex(item => item.id === laneOfSelected()) + delta];
    if (!lane) return;
    const cards = cardsIn(lane.id);
    select(cards.find(card => card.id === state.lastInLane[lane.id]) ?? cards[0]);
  }

  /** What / finds: the board's cards, or every board's from Today, matched as the web palette matches them. */
  const searchResults = () => {
    const scope = state.view === "today" ? state.today : state.cards;
    return searchRank(scope.map(card => ({ label: card.title, keywords: card.id, card })), state.search.query).map(item => item.card);
  };
  /** Opens a found card, and moves the board's selection to it so esc lands there. */
  function openFound(card) {
    if (state.view === "board") {
      if (card.status === "archived") state.all = true;
      select(card);
    } else if (todayCards().some(item => item.id === card.id)) state.todayAt = todayCards().findIndex(item => item.id === card.id);
    state.search = null;
    return openDetails(card);
  }
  function searchKey(name) {
    const search = state.search;
    if (name === "escape") { state.search = null; state.mode = "board"; return; }
    if (name === "enter") { const card = search.query.trim() && searchResults()[search.at]; return card ? openFound(card) : undefined; }
    if (name === "down" || name === "up") { search.at = Math.max(0, Math.min(searchResults().length - 1, search.at + (name === "down" ? 1 : -1))); return; }
    if (name === "backspace") search.query = [...search.query].slice(0, -1).join("");
    else if ([...name].length === 1 && name >= " ") search.query += name;
    else return;
    search.at = 0;
  }

  /**
   * A mouse press: a click acts on the zone drawn under it, the wheel moves like the arrow keys. A click while a question
   * or the key list is up answers no or closes it, like esc. Releases and drags do nothing.
   */
  async function pointer(button, x, y, press) {
    if (!press || button & 32) return;
    if (state.confirm || state.mode === "help") return key("escape");
    if (button & 64) return key(button & 1 ? "down" : "up");
    if (button & 3) return;
    const target = state.zones.findLast(zone => x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h)?.target;
    if (!target) return;
    if (target.key) return key(target.key);
    if (target.card) {
      if (state.selected === target.card) return openDetails();
      return select(state.cards.find(card => card.id === target.card));
    }
    if (target.today !== undefined) {
      if (state.todayAt === target.today) return openDetails();
      state.todayAt = target.today;
    } else if (target.found !== undefined) {
      if (state.search.at === target.found) return searchKey("enter");
      state.search.at = target.found;
    } else if (target.tab !== undefined) { state.tab = target.tab; state.scroll = 0; }
  }

  async function key(name) {
    if (name === "interrupt") { state.quit = true; return; }
    const mouse = /^mouse:(\d+):(\d+):(\d+):([Mm])$/.exec(name);
    if (mouse) return pointer(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4] === "M");
    if (state.mode === "search") return searchKey(name);
    if (state.confirm) {
      const { run } = state.confirm;
      state.confirm = null;
      if (name === "y" || name === "Y") {
        try { await run(); } catch (error) { say(error.message, true); }
      } else say("Cancelled");
      return;
    }
    if (state.mode === "help") { state.mode = "board"; return; }
    if (state.mode === "details") {
      if (name === "escape" || name === "q" || name === "left" || name === "h" || name === "enter") { state.mode = "board"; return; }
      if (name === "tab" || name === "]" || name === "[") { state.tab = 1 - state.tab; state.scroll = 0; return; }
      if (name === "down" || name === "j") { state.scroll++; return; }
      if (name === "up" || name === "k") { state.scroll = Math.max(0, state.scroll - 1); return; }
      if (name === "pagedown" || name === " ") { state.scroll += size().rows - 10; return; }
      if (name === "pageup") { state.scroll = Math.max(0, state.scroll - size().rows + 10); return; }
    }
    say("");
    const card = current();
    if (name === "q") { state.quit = true; return; }
    if (name === "0") return show(state.view === "today" ? "board" : "today");
    if (/^[1-9]$/.test(name)) {
      const item = state.boards[Number(name) - 1];
      return item ? show("board", item) : say(`${name}: no board with that number`);
    }
    if (name === "escape" && state.view === "today") return show("board");
    if (name === "b") { state.sidebar = !showSidebar(); return; }
    if (name === "down" || name === "j") return move(1);
    if (name === "up" || name === "k") return move(-1);
    if (name === "pagedown") return move(5);
    if (name === "pageup") return move(-5);
    if (name === "g") return move(-Infinity);
    if (name === "G") return move(Infinity);
    if (name === "right" || name === "l") return jumpLane(1);
    if (name === "left" || name === "h") return jumpLane(-1);
    if (name === "enter") return openDetails();
    if (name === "?") { state.mode = "help"; return; }
    if (name === "/") { state.mode = "search"; state.search = { query: "", at: 0 }; return; }
    if (name === "A") {
      state.all = !state.all;
      if (!state.all && selectedOnBoard()?.status === "archived") select(cardsIn(filled()[0]?.id)[0]);
      return;
    }
    if (name === "o" && card) { open(webUrl(card.id, boardOf(card).id)); say("Opened the card in the browser"); return; }
    const action = card && cardActions(card, boardOf(card)).find(item => item.key === name);
    if (action) {
      try { await act(action.act, card); } catch (error) { say(error.message, true); }
    } else if (card && "rtsxaR".includes(name) && name.length === 1) say(`${name}: not available for this card`);
  }

  const spinner = () => SPINNER[Math.floor(now() / 250) % SPINNER.length];
  const glyph = (card, lane) =>
    lane.id === "running" ? [spinner(), "33"]
      : lane.id === "ready" && card.blocked ? ["◌", DIM]
      : card.status === "interrupted" ? ["✗", "33"]
      : [lane.glyph, lane.style];
  const ago = iso => {
    const minutes = Math.max(0, (now() - Date.parse(iso)) / 60_000);
    return minutes < 60 ? `${Math.round(minutes)}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
  };

  /** The boards, numbered for their keys, with Today above them. Counts come from `/api/boards`, as on the web. */
  function drawSidebar(screen, w, rows) {
    for (let y = 0; y < rows - 2; y++) screen.put(w, y, "│", DIM);
    screen.put(1, 0, "alice.", ACCENT);
    const needsYou = state.boards.reduce((sum, item) => sum + needsYouStatuses.reduce((n, status) => n + (item.cardCounts?.[status] ?? 0), 0), 0);
    const today = state.view === "today";
    screen.parts(1, 2, [["0 ", DIM], ["Today", today ? ACCENT : ""]]);
    screen.zone(0, 2, w, 1, { key: "0" });
    if (needsYou) screen.put(w - 1 - String(needsYou).length, 2, String(needsYou), "34");
    state.boards.slice(0, Math.max(0, rows - 7)).forEach((item, i) => {
      const y = 4 + i, here = !today && item.id === state.board.id, counts = item.cardCounts ?? {};
      screen.parts(1, y, [[i < 9 ? `${i + 1} ` : "  ", DIM], [clip(nameOf(item), w - 9), here ? ACCENT : ""]]);
      if (counts.running) screen.put(w - 6, y, spinner(), "33");
      if (counts.review) screen.put(w - 1 - String(counts.review).length, y, String(counts.review), "34");
      if (i < 9) screen.zone(0, y, w, 1, { key: String(i + 1) });
    });
  }

  function header(screen, left, columns) {
    let x = screen.parts(left + 1, 0, [[nameOf(state.board), "1"], ["    ", ""]]);
    for (const id of ["triage", "ready", "running", "review"]) {
      const count = state.cards.filter(card => card.status === id).length;
      x = screen.parts(x, 0, [[String(count), `1;${LANES.find(lane => lane.id === id).style}`], [` ${id}   `, DIM]]);
    }
    const right = [];
    if (state.conflicts) right.push([`✗ ${state.conflicts} merge conflict${state.conflicts === 1 ? "" : "s"}`, "31"], ["    ", ""]);
    if (typeof state.board.cost24h === "number") right.push([`$${state.board.cost24h.toFixed(2)}`, ""], [" in 24h", DIM]);
    const used = right.reduce((sum, [text]) => sum + width(text), 0);
    if (x + used < columns) screen.parts(columns - 1 - used, 0, right);
    screen.put(left, 1, "─".repeat(columns - left), DIM);
  }

  /**
   * Which lanes fit, how wide each is, and which lanes sit off screen to the left and right. Empty lanes that the
   * board auto-collapses become a strip; the view slides sideways to keep the selected card's lane on screen.
   */
  function laneLayout(columns) {
    const strip = 4, edge = 6, list = lanes().map(lane => ({ ...lane, count: cardsIn(lane.id).length }));
    for (const lane of list) lane.collapsed = !lane.count && (state.board.autoCollapseEmptySwimlanes ?? true);
    const open = list.filter(lane => !lane.collapsed);
    const min = Math.max(12, Math.min(30, columns - 2 * edge - 1)), max = 44;
    const room = from => columns - 1 - (from > 0 ? edge : 0) - edge;
    const fit = from => {
      const shown = [];
      let used = 0;
      for (const lane of list.slice(list.indexOf(open[from]))) {
        const w = lane.collapsed ? strip : min;
        if (used + w > room(from)) break;
        shown.push({ ...lane, w }); used += w + 1;
      }
      return { shown, used };
    };
    const focus = Math.max(0, open.findIndex(lane => lane.id === laneOfSelected()));
    let start = Math.min(state.laneStart, focus);
    while (start < focus && !fit(start).shown.some(lane => lane.id === open[focus].id)) start++;
    state.laneStart = start;
    const { shown, used } = fit(start);
    const at = id => list.findIndex(lane => lane.id === id);
    const left = list.slice(0, at(shown[0]?.id)).filter(lane => !lane.collapsed);
    const right = list.slice(at(shown.at(-1)?.id) + 1).filter(lane => !lane.collapsed);
    const wide = shown.filter(lane => !lane.collapsed);
    const spare = room(start) + (right.length ? 0 : edge) - used;
    const grow = Math.max(0, Math.min(max - min, Math.floor(spare / Math.max(1, wide.length))));
    for (const lane of wide) lane.w += grow;
    return { shown, left, right };
  }

  function tile(card, w, at) {
    const inner = Math.max(1, w - 6), pill = tilePill(card, state.cards, at, split());
    const lines = wrap(card.title, inner, 2);
    return { lines, pill: pill && [clip(pill[0], inner), pill[1]], h: lines.length + (pill ? 1 : 0) + 2 };
  }

  function drawBoard(screen, left, columns, bottom) {
    header(screen, left, columns);
    if (!state.cards.length) { screen.put(left + 1, 3, "No cards on this board yet.", DIM); return; }
    const top = 2, at = now();
    const { shown, left: before, right: after } = laneLayout(columns - left);
    const edgeStrip = (x, list, arrow) => {
      screen.box(x, top, 5, bottom - top, DIM);
      screen.put(x + 2, top + 1, arrow, ACCENT);
      list.forEach((lane, i) => { screen.put(x + 1, top + 3 + i * 3, "●", lane.style); screen.put(x + 1, top + 4 + i * 3, String(lane.count).padStart(3), DIM); });
      screen.zone(x, top, 5, bottom - top, { key: arrow === "‹" ? "h" : "l" });
    };
    let x = left;
    if (before.length) { edgeStrip(left, before, "‹"); x = left + 6; }
    if (after.length) edgeStrip(columns - 6, after, "›");
    for (const lane of shown) {
      if (lane.collapsed) {
        screen.box(x, top, lane.w, bottom - top, DIM);
        screen.put(x + 1, top + 1, "●", lane.style);
        [...lane.label].slice(0, bottom - top - 4).forEach((ch, i) => screen.put(x + 1, top + 3 + i, ch, DIM));
        x += lane.w + 1;
        continue;
      }
      const cards = cardsIn(lane.id), focused = lane.id === laneOfSelected();
      const count = String(lane.count);
      screen.parts(x + 1, top, [focused ? ["●", ACCENT] : lane.id === "running" ? [spinner(), "33"] : ["●", lane.style], [` ${clip(lane.label, lane.w - count.length - 5)}`, focused ? ACCENT : ""]]);
      screen.put(x + lane.w - count.length - 1, top, count, DIM);
      // Scroll the lane so its selected card is on screen.
      const tiles = cards.map(card => tile(card, lane.w, at));
      const focusAt = focused ? cards.findIndex(card => card.id === state.selected) : -1;
      let off = Math.min(state.laneScroll[lane.id] ?? 0, Math.max(0, cards.length - 1));
      const fits = from => { let y = top + 2 + (from ? 1 : 0), i = from; while (i < tiles.length && y + tiles[i].h <= bottom - 1) y += tiles[i++].h; return i; };
      if (focusAt >= 0 && focusAt < off) off = focusAt;
      while (focusAt >= fits(off) && off < focusAt) off++;
      state.laneScroll[lane.id] = off;
      let y = top + 2;
      if (off) { screen.put(x + 2, y, `↑ ${off} more`, DIM); y++; }
      let i = off;
      for (; i < cards.length && y + tiles[i].h <= bottom - 1; i++) {
        const card = cards[i], t = tiles[i], selected = card.id === state.selected;
        screen.box(x, y, lane.w, t.h, selected ? ACCENT : card.status === "running" ? "33" : DIM, selected);
        const [mark, markStyle] = glyph(card, lane);
        screen.put(x + 2, y + 1, mark, markStyle);
        t.lines.forEach((line, j) => screen.put(x + 4, y + 1 + j, line, selected ? "1" : ""));
        if (t.pill) screen.put(x + 4, y + 1 + t.lines.length, ...t.pill);
        screen.zone(x, y, lane.w, t.h, { card: card.id });
        y += t.h;
      }
      if (i < cards.length) screen.put(x + 2, y, `↓ ${cards.length - i} more`, DIM);
      x += lane.w + 1;
    }
  }

  /** Today, as on the web: the day's counts, then what's running, what needs you and what's approved, a row a card. */
  function drawToday(screen, left, columns, bottom) {
    const w = Math.min(110, columns - left - 4), x = left + Math.floor((columns - left - w) / 2);
    const { attention, finished } = todaySections(state.today, since());
    const spent = state.boards.reduce((sum, item) => sum + (item.cost24h ?? 0), 0);
    screen.parts(x, 0, [["Today", "1"], [`   ${new Date(now()).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`, DIM]]);
    screen.parts(x, 1, [[String(finished.length), "1;32"], [" merged   ", DIM], [String(attention.length), "1;34"], [" need you   ", DIM], [`$${spent.toFixed(2)}`, ""], [" in 24h", DIM]]);
    const rows = todayRows(), top = 3, room = bottom - top;
    if (!rows.length) { screen.put(x, top, "Nothing needs you right now.", DIM); return; }
    // Keep the selected card in the middle of the screen once the list is longer than it.
    const selectedRow = rows.findIndex(row => row.card === todayCards()[state.todayAt]);
    const off = Math.max(0, Math.min(selectedRow - Math.floor(room / 2), rows.length - room));
    rows.slice(off, off + room).forEach((row, i) => {
      const y = top + i;
      if (!row.card) { screen.put(x, y, row.label, row.style); return; }
      const card = row.card, selected = off + i === selectedRow, home = boardOf(card);
      const lane = LANES.find(item => item.id === laneOf(card, isPullRequestBoard(home))) ?? LANES[0];
      const age = ago(card.updatedAt), pill = needsYourReview(card) ? null : tilePill(card, state.today, now(), isPullRequestBoard(home));
      const pillText = pill && clip(pill[0], 30), titleRoom = w - 24 - (pill ? width(pillText) + 2 : 0);
      if (selected) screen.put(x - 2, y, "▸", ACCENT);
      const end = screen.parts(x, y, [glyph(card, lane), [` ${clip(card.title, titleRoom)}`, selected ? "1" : ""]]);
      if (pill) screen.put(end + 2, y, pillText, pill[1]);
      screen.put(x + w - 20, y, clip(nameOf(home), 14), DIM);
      screen.put(x + w - width(age), y, age, DIM);
      screen.zone(x - 2, y, w + 2, 1, { today: todayCards().indexOf(card) });
    });
  }

  /** Card markdown as styled lines: bullets and numbered steps hang, `code` is cyan, **bold** is bold. */
  function markdown(text, max) {
    const out = [];
    const inline = line => {
      const parts = [], pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
      let last = 0, match;
      while ((match = pattern.exec(line))) {
        if (match.index > last) parts.push([line.slice(last, match.index), ""]);
        parts.push(match[1] ? [match[1], "36"] : [match[2], "1"]);
        last = pattern.lastIndex;
      }
      if (last < line.length) parts.push([line.slice(last), ""]);
      return parts;
    };
    const flow = (parts, indent = 0) => {
      const rows = [[]];
      let used = 0;
      for (const [text, style] of parts) for (const word of text.split(/(\s+)/)) {
        if (!word) continue;
        if (/^\s+$/.test(word)) { if (used) { rows.at(-1).push([" ", ""]); used++; } continue; }
        const w = width(word);
        if (used > indent && used + w > max) { rows.push([[" ".repeat(indent), ""]]); used = indent; }
        rows.at(-1).push([clip(word, max - indent), style]); used += Math.min(w, max - indent);
      }
      return rows;
    };
    for (const raw of String(text).split("\n")) {
      const line = raw.trimEnd(), bullet = /^\s*[-*]\s+(.*)/.exec(line), step = /^\s*(\d+)\.\s+(.*)/.exec(line), heading = /^#+\s+(.*)/.exec(line);
      if (!line.trim()) out.push([]);
      else if (bullet) out.push(...flow([["• ", DIM], ...inline(bullet[1])], 2));
      else if (step) out.push(...flow([[`${step[1]}. `, DIM], ...inline(step[2])], step[1].length + 2));
      else if (heading) out.push(...flow([[heading[1], "1"]]));
      else out.push(...flow(inline(line)));
    }
    return out;
  }

  function detailLines(card, max) {
    const runs = state.details.runs;
    if (state.tab === 1) {
      if (!runs) return [[["Loading attempts…", DIM]]];
      if (!runs.length) return [[["No attempts yet.", DIM]]];
      return runs.flatMap(run => [
        [[`Attempt ${run.attempt}`, "1"], [` · ${run.status}${run.agent ? ` · ${run.agent}` : ""}${run.turns ? ` · ${run.turns} turns` : ""}${run.cost ? ` · $${run.cost.toFixed(2)}` : ""}`, run.status === "failed" ? "31" : DIM]],
        ...(run.error ? wrap(run.error, max).map(line => [[line, "31"]]) : []),
        ...markdown(run.report ?? "", max).slice(0, 3).map(row => row.map(([text]) => [text, DIM])),
        [],
      ]);
    }
    const lines = markdown(card.body || "No description.", max);
    if (card.attachmentCount) lines.push([], [[`⇩ ${card.attachmentCount} attachment${card.attachmentCount === 1 ? "" : "s"}`, ""], ["   o opens them in the browser", DIM]]);
    const run = runs?.[0];
    if (!runs) lines.push([], [["Loading the latest attempt…", DIM]]);
    else if (run) {
      lines.push([], [["Latest attempt", ACCENT], [`   ${run.attempt} · ${run.status}`, DIM]], []);
      if (run.error) lines.push(...wrap(run.error, max).map(line => [[line, "31"]]));
      if (run.report) lines.push(...markdown(run.report, max));
    }
    return lines;
  }

  /** The / dialog: the query, then a row per matching card with its lane, and its board on Today. */
  function drawSearch(screen, columns, bottom) {
    screen.dim();
    const w = Math.min(90, columns - 2), h = bottom - 1, x = Math.floor((columns - w) / 2), y = 1, inner = w - 6, { query } = state.search;
    screen.clear(x, y, w, h);
    screen.box(x, y, w, h, DIM);
    screen.zone(0, 0, columns, bottom, { key: "escape" });
    screen.zone(x, y, w, h, {});
    const end = screen.parts(x + 3, y + 1, [["/ ", ACCENT], [clip(query, inner - 4), "1"]]);
    screen.put(end, y + 1, "▏", ACCENT);
    const top = y + 3, room = Math.max(1, y + h - 1 - top);
    if (!query.trim()) { screen.put(x + 3, top, `Type to find a card ${state.view === "today" ? "on any board" : "on this board"} by its title or id.`, DIM); return; }
    const results = searchResults();
    if (!results.length) { screen.put(x + 3, top, "No cards match.", DIM); return; }
    const count = `${results.length} card${results.length === 1 ? "" : "s"}`;
    screen.put(x + w - 3 - width(count), y + 1, count, DIM);
    state.search.at = Math.min(state.search.at, results.length - 1);
    const off = Math.max(0, Math.min(state.search.at - Math.floor(room / 2), results.length - room));
    results.slice(off, off + room).forEach((card, i) => {
      const row = top + i, selected = off + i === state.search.at, home = boardOf(card);
      const lane = LANES.find(item => item.id === laneOf(card, isPullRequestBoard(home))) ?? LANES[0];
      const detail = state.view === "today" ? `${lane.label} · ${nameOf(home)}` : lane.label;
      const where = clip(detail, 30);
      if (selected) screen.put(x + 1, row, "▸", ACCENT);
      screen.parts(x + 3, row, [glyph(card, lane), [` ${clip(card.title, inner - width(where) - 4)}`, selected ? "1" : ""]]);
      screen.put(x + w - 3 - width(where), row, where, DIM);
      screen.zone(x + 1, row, w - 2, 1, { found: off + i });
    });
  }

  function drawDetails(screen, columns, bottom) {
    screen.dim();
    const known = [...state.cards, ...state.today], card = shownCard();
    const w = Math.min(104, columns - 2), h = bottom - 1, x = Math.floor((columns - w) / 2), y = 1, inner = w - 6;
    screen.clear(x, y, w, h);
    screen.box(x, y, w, h, DIM);
    // A click outside the dialog closes it; one inside does nothing but switch tabs.
    screen.zone(0, 0, columns, bottom, { key: "escape" });
    screen.zone(x, y, w, h, {});
    screen.zone(x + 3, y + 4, 8, 1, { tab: 0 });
    screen.zone(x + 15, y + 4, 12, 1, { tab: 1 });
    const lane = LANES.find(item => item.id === laneOf(card, isPullRequestBoard(boardOf(card)))) ?? LANES[0];
    const pill = needsYourReview(card) ? [" Needs you ", PILL_YOU] : tilePill(card, known, now(), isPullRequestBoard(boardOf(card)));
    screen.parts(x + 3, y + 1, [glyph(card, lane), [` ${clip(card.title, inner - 2)}`, "1"]]);
    let at = screen.parts(x + 5, y + 2, [[lane.label, lane.style], ["   ", ""]]);
    if (pill) at = screen.parts(at, y + 2, [[clip(pill[0], 40), pill[1]], ["   ", ""]]);
    if (card.attempts > 1) at = screen.parts(at, y + 2, [[`↻ ${card.attempts} attempts   `, DIM]]);
    if (state.view === "today") screen.put(at, y + 2, nameOf(boardOf(card)), DIM);
    screen.parts(x + 3, y + 4, [["Overview", state.tab === 0 ? "1;4;33" : DIM], ["    ", ""], [`Attempts ${card.attempts ?? 0}`, state.tab === 1 ? "1;4;33" : DIM]]);
    const lines = detailLines(card, inner), top = y + 6, room = Math.max(1, y + h - 1 - top);
    state.scroll = Math.max(0, Math.min(state.scroll, lines.length - room));
    lines.slice(state.scroll, state.scroll + room).forEach((row, i) => screen.parts(x + 3, top + i, row));
    if (lines.length > room) {
      const thumb = Math.max(1, Math.round((room / lines.length) * room)), from = Math.round((state.scroll / (lines.length - room)) * (room - thumb));
      for (let i = 0; i < room; i++) screen.put(x + w - 2, top + i, i >= from && i < from + thumb ? "┃" : "│", i >= from && i < from + thumb ? "33" : DIM);
    }
  }

  function footer(screen, columns, rows) {
    // A question wraps upward over the board rather than losing its y/N off the edge.
    const [text, style] = state.confirm ? [`${state.confirm.text} y/N`, "33"] : [state.message, state.error ? "31" : DIM];
    const lines = text ? wrap(text, columns - 2, 3) : [];
    screen.clear(0, rows - 1 - lines.length, columns, lines.length);
    lines.forEach((line, i) => screen.put(1, rows - 1 - lines.length + i, line, style));
    if (state.mode === "help") return;
    if (state.mode === "search") {
      screen.parts(1, rows - 1, [["↑ ↓", "1"], [" results   ", DIM], ["⏎", "1"], [" open   ", DIM], ["esc", "1"], [" close", DIM]]);
      return;
    }
    const card = current(), actions = card ? cardActions(card, boardOf(card)).map(item => [item.key, item.label]) : [];
    const keys = state.mode === "details" ? [["esc", "close"], ["tab", "attempts"], ["j k", "scroll"], ...actions, ["o", "browser"]]
      : state.view === "today" ? [["↑ ↓", "cards"], ["⏎", "open"], ...actions, ["/", "find"], ["0", "board"], ["1–9", "boards"], ["?", "keys"], ["q", "quit"]]
      : [["← →", "lanes"], ["↑ ↓", "cards"], ["⏎", "open"], ...actions, ["/", "find"], ["0", "today"], ["1–9", "boards"], ["?", "keys"], ["q", "quit"]];
    let x = 1;
    for (const [name, label] of keys) {
      if (x + width(name) + width(label) + 1 > columns) break;
      const start = x, press = { "⏎": "enter", esc: "escape", tab: "tab" }[name] ?? ([...name].length === 1 ? name : null);
      x = screen.parts(x, rows - 1, [[name, "1"], [` ${label}   `, DIM]]);
      if (press) screen.zone(start, rows - 1, x - start - 2, 1, { key: press });
    }
  }

  /** The screen as lines, exactly `rows` long and `columns` wide. */
  function render() {
    const { columns, rows } = size();
    const screen = new Screen(columns, rows), bottom = rows - 2;
    if (state.mode === "help") {
      screen.put(1, 0, "Keys", "1");
      HELP.forEach(([keys, text], i) => screen.parts(2, 2 + i, [[keys.padEnd(10), "1"], [`  ${text}`, ""]]));
      screen.put(1, HELP.length + 3, "Any key to go back.", DIM);
    } else {
      const left = showSidebar() ? 23 : 0;
      if (left) drawSidebar(screen, left - 1, rows);
      if (state.view === "today") drawToday(screen, left, columns, bottom);
      else drawBoard(screen, left, columns, bottom);
      if (state.mode === "details") drawDetails(screen, columns, bottom);
      if (state.mode === "search") drawSearch(screen, columns, bottom);
    }
    footer(screen, columns, rows);
    state.zones = screen.zones;
    return screen.lines(color);
  }

  /** A running card shows a spinner, so the screen needs redrawing between refreshes. */
  const animating = () => state.mode !== "help" && (state.view === "today" ? state.today : state.cards).some(card => card.status === "running");

  return { state, refresh, key, render, animating };
}

/**
 * Opens `url` in the browser: `$BROWSER` when set, else the platform's opener. Returns false when there is nothing to
 * open it with (no display over SSH), so the caller can rely on the printed URL instead.
 */
export function openUrl(url) {
  const browser = process.env.BROWSER?.trim();
  const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (!browser && headless) return false;
  const [command, args] = browser ? [browser, [url]]
    : process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
}

/** Runs the TUI on this terminal until q or Ctrl-C, refreshing every 2 seconds. */
export async function runTui({ api, board, today, webUrl }) {
  const input = process.stdin, out = process.stdout;
  const tui = createTui({ api, board, today, webUrl, open: openUrl, color: useColor(out), size: () => ({ columns: out.columns || 80, rows: out.rows || 24 }) });
  // Only rows that changed are written, inside a synchronized update, so a spinner frame costs a few bytes and the
  // terminal never shows half a frame.
  let drawn = [];
  const draw = () => {
    const lines = tui.render();
    let changes = "";
    lines.forEach((line, i) => { if (line !== drawn[i]) changes += `\x1b[${i + 1};1H${line}`; });
    drawn = lines;
    if (changes) out.write(`\x1b[?2026h${changes}\x1b[?2026l`);
  };
  let timer;
  const frames = setInterval(() => { if (tui.animating()) draw(); }, 250);
  const finish = () => {
    clearTimeout(timer);
    clearInterval(frames);
    input.setRawMode(false);
    out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    process.exit(0);
  };
  // Mouse presses and the wheel arrive as SGR reports (1000 and 1006); hold Shift to select text as usual.
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  out.on("resize", () => { drawn = []; out.write("\x1b[2J"); draw(); });
  // Keys are handled one at a time, in order, even when an action awaits the server.
  let queue = Promise.resolve();
  input.on("data", data => {
    queue = queue.then(async () => {
      for (const name of keyNames(data)) {
        try { await tui.key(name); } catch (error) { tui.state.message = error.message; tui.state.error = true; }
        if (tui.state.quit) finish();
      }
      draw();
    });
  });
  const tick = async () => {
    try { await tui.refresh(); } catch (error) { tui.state.message = error.message; tui.state.error = true; }
    draw();
    timer = setTimeout(tick, 2000);
  };
  await tick();
}
