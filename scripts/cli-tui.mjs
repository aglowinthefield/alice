// `bakery-cli tui`: the board in the terminal, driven by keys. `createTui` holds the state and answers keys without
// touching the terminal, so tests drive it with a fake API; `runTui` wires it to a raw-mode TTY.
import { spawn } from "node:child_process";
import { needsYourReview } from "../shared/card-state.ts";
import { badges, boardRows } from "./cli-board.mjs";
import { c, wrap } from "./cli-style.mjs";

const KEYS = { "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down", "\x1b[C": "right", "\x1bOC": "right", "\x1b[D": "left", "\x1bOD": "left", "\r": "enter", "\n": "enter", "\x1b": "escape", "\x03": "interrupt", "\x1b[5~": "pageup", "\x1b[6~": "pagedown" };
export const keyName = data => KEYS[data] ?? data;
/** One chunk of terminal input as key names: fast typing and pastes arrive several keys at a time. */
export function keyNames(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const sequence = /^(?:\x1b\[[\d;]*[~A-Za-z]|\x1bO[A-D]|\r\n)/.exec(data.slice(i))?.[0] ?? data[i];
    out.push(keyName(sequence === "\r\n" ? "\r" : sequence));
    i += sequence.length;
  }
  return out;
}

/** Cuts text to `width` visible characters, keeping its colour codes. */
export function clipAnsi(text, width) {
  let out = "", seen = 0;
  for (let i = 0; i < text.length; i++) {
    const code = /^\x1b\[[\d;?]*[a-zA-Z]/.exec(text.slice(i));
    if (code) { out += code[0]; i += code[0].length - 1; continue; }
    if (seen === width) return `${out}\x1b[0m`;
    out += text[i]; seen++;
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

const HELP = [
  ["↑ ↓  j k", "move between cards"], ["← →  h l", "previous or next lane"], ["g  G", "first or last card"],
  ["enter", "card details (esc to go back)"], ["o", "open the card in the browser"], ["A", "show or hide Archive and old Done cards"],
  ["r  t", "move to Ready or back to Triage"], ["s", "start or run again (asks first: paid)"], ["x", "stop a running agent"],
  ["a", "approve, accept findings, or update the PR"], ["R", "recover a Failed card in a fresh session"], ["q", "quit"],
];

export function createTui({ api, board, title = "", size = () => ({ columns: 80, rows: 24 }), open = () => {}, webUrl = id => id, now = () => Date.now() }) {
  const path = `/api/boards/${encodeURIComponent(board.id)}`;
  const state = { cards: [], selected: null, all: false, mode: "board", confirm: null, message: "", error: false, details: null, offset: 0, scroll: 0, quit: false };
  const rows = () => boardRows(state.cards, { width: size().columns, now: now(), all: state.all, title });
  const selectable = () => rows().filter(row => row.card);
  const current = () => state.cards.find(card => card.id === state.selected);
  const say = (message, error = false) => { state.message = message; state.error = error; };
  const select = row => { if (row) state.selected = row.card.id; };

  async function refresh() {
    state.cards = await api("GET", `${path}/cards`);
    const list = selectable();
    if (!list.some(row => row.card.id === state.selected)) select(list[0]);
  }

  async function openDetails() {
    const card = current();
    if (!card) return;
    state.mode = "details"; state.scroll = 0; state.details = { card, runs: null };
    try { state.details.runs = await api("GET", `${path}/cards/${card.id}/runs`); }
    catch (error) { say(error.message, true); }
  }

  const ask = (text, run) => { state.confirm = { text, run }; };
  // The card text check behind the web board's Ready dialog. A server without it answers 404, so nothing is flagged.
  async function readyFlags(base) {
    try { return (await api("GET", `${base}/ready-check`)).flags ?? []; }
    catch (error) { if (/^Bakery 404: Not found$/.test(error.message)) return []; throw error; }
  }
  async function act(action, card) {
    const base = `${path}/cards/${card.id}`;
    const quoted = `“${card.title.length > 50 ? `${card.title.slice(0, 49)}…` : card.title}”`;
    const done = message => async () => { await refresh(); say(message); };
    if (action === "ready") {
      const move = async () => { await api("POST", `${base}/status`, { status: "ready" }); await done(`Moved ${quoted} to Ready`)(); };
      // Same check as the web board's dialog: y is Ready anyway; n leaves it in Triage, and o opens it to edit.
      const flags = await readyFlags(base);
      const pickup = board.autoPickupEnabled ? " Pickup is on, so it can start a paid Pi run soon." : "";
      if (flags.length) ask(`${quoted} may need another pass: ${flags.map(flag => flag.message).join("; ")}.${pickup} Move it to Ready anyway?`, move);
      else if (pickup) ask(`Pickup is on, so Ready can start a paid Pi run soon. Move ${quoted} to Ready?`, move);
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
      else if (board.integration === "github-pr" && card.prState !== "OPEN")
        say("A new pull request needs its title and body reviewed. Press o to finish it in the browser.");
      else if (board.integration === "github-pr")
        ask(`Approve ${review.files.length} changed file(s) and push them to PR #${card.prNumber}? The card is Done once the PR merges.`, async () => { await api("POST", `${base}/approve`, { fingerprint }); await done(`Pushed ${quoted} to PR #${card.prNumber}`)(); });
      else
        ask(`Approve ${review.files.length} changed file(s) and merge ${quoted} into local main? Bakery does not run tests or push.`, async () => { await api("POST", `${base}/approve`, { fingerprint }); await done(`Merged ${quoted} into local main`)(); });
    }
  }

  function move(delta) {
    const list = selectable(), at = list.findIndex(row => row.card.id === state.selected);
    select(list[Math.max(0, Math.min(list.length - 1, at + delta))]);
  }
  function jumpLane(delta) {
    const list = selectable(), at = list.findIndex(row => row.card.id === state.selected);
    const lanesInOrder = [...new Set(list.map(row => row.lane))];
    const lane = lanesInOrder[lanesInOrder.indexOf(list[at]?.lane) + delta];
    if (lane) select(list.find(row => row.lane === lane));
  }

  async function key(name) {
    if (name === "interrupt") { state.quit = true; return; }
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
      if (name === "down" || name === "j") { state.scroll++; return; }
      if (name === "up" || name === "k") { state.scroll = Math.max(0, state.scroll - 1); return; }
      if (name === "pagedown") { state.scroll += size().rows - 4; return; }
      if (name === "pageup") { state.scroll = Math.max(0, state.scroll - size().rows + 4); return; }
    }
    say("");
    const card = current();
    if (name === "q") { state.quit = true; return; }
    if (name === "down" || name === "j") return move(1);
    if (name === "up" || name === "k") return move(-1);
    if (name === "pagedown") return move(size().rows - 4);
    if (name === "pageup") return move(-(size().rows - 4));
    if (name === "g") return move(-Infinity);
    if (name === "G") return move(Infinity);
    if (name === "right" || name === "l") return jumpLane(1);
    if (name === "left" || name === "h") return jumpLane(-1);
    if (name === "enter") return openDetails();
    if (name === "?") { state.mode = "help"; return; }
    if (name === "A") { state.all = !state.all; state.offset = 0; return; }
    if (name === "o" && card) { open(webUrl(card.id)); say("Opened the card in the browser"); return; }
    const action = cardActions(card, board).find(item => item.key === name);
    if (action) {
      try { await act(action.act, card); } catch (error) { say(error.message, true); }
    } else if (card && "rtsxaR".includes(name) && name.length === 1) say(`${name}: not available for this card`);
  }

  function detailLines(width) {
    const { card, runs } = state.details;
    const fresh = state.cards.find(item => item.id === card.id) ?? card;
    const lines = [c.bold(fresh.title), c.dim(`${fresh.id} · ${fresh.status}`)];
    const tags = badges(fresh, state.cards, now());
    if (tags.length) lines.push(tags.join(c.dim(" · ")));
    lines.push("");
    for (const paragraph of (fresh.body || "No description.").split("\n")) lines.push(...(paragraph.trim() ? wrap(paragraph, width - 2) : [""]));
    const run = runs?.[0];
    if (!runs) lines.push("", c.dim("Loading attempts…"));
    else if (!run) lines.push("", c.dim("No attempts yet."));
    else {
      lines.push("", c.bold(`Attempt ${run.attempt}`) + c.dim(` · ${run.status}${run.agent ? ` · ${run.agent}` : ""}`));
      if (run.error) lines.push(...wrap(run.error, width - 2).map(line => c.bad(line)));
      if (run.report) for (const paragraph of run.report.split("\n")) lines.push(...(paragraph.trim() ? wrap(paragraph, width - 2) : [""]));
    }
    return lines;
  }

  function footer(width) {
    const status = state.confirm ? c.warn(`${state.confirm.text} y/N`) : state.error ? c.bad(state.message) : c.dim(state.message);
    const keys = state.mode === "board" || state.mode === "details"
      ? [...cardActions(current(), board).map(item => `${c.bold(item.key)} ${item.label}`), state.mode === "board" ? `${c.bold("⏎")} details` : `${c.bold("esc")} back`, `${c.bold("o")} browser`, `${c.bold("?")} keys`, `${c.bold("q")} quit`]
      : [];
    return [status, keys.join("   ")].map(line => clipAnsi(line, width));
  }

  /** The screen as lines, exactly `rows` long. */
  function render() {
    const { columns: width, rows: height } = size();
    const room = Math.max(1, height - 2);
    let body;
    if (state.mode === "help") body = [c.bold("Keys"), "", ...HELP.map(([keys, text]) => `  ${c.bold(keys.padEnd(10))}  ${text}`), "", c.dim("Any key to go back.")];
    else if (state.mode === "details") {
      const lines = detailLines(width);
      state.scroll = Math.min(state.scroll, Math.max(0, lines.length - room));
      body = lines.slice(state.scroll, state.scroll + room);
    } else {
      const all = rows();
      const at = all.findIndex(row => row.card?.id === state.selected);
      if (at >= 0 && at < state.offset) state.offset = at;
      if (at >= state.offset + room) state.offset = at - room + 1;
      state.offset = Math.max(0, Math.min(state.offset, Math.max(0, all.length - room)));
      body = all.slice(state.offset, state.offset + room).map(row => row.card?.id === state.selected ? `${c.info("▸")}${row.text.slice(1)}` : row.text);
      if (!state.cards.length) body = [c.dim("No cards on this board yet.")];
    }
    const lines = body.map(line => clipAnsi(line, width));
    while (lines.length < room) lines.push("");
    return [...lines.slice(0, room), ...footer(width)];
  }

  return { state, refresh, key, render };
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

/** Runs the TUI on this terminal until q or Ctrl-C, refreshing the board every 2 seconds. */
export async function runTui({ api, board, title, webUrl }) {
  const input = process.stdin, out = process.stdout;
  const tui = createTui({ api, board, title, webUrl, open: openUrl, size: () => ({ columns: out.columns || 80, rows: out.rows || 24 }) });
  const draw = () => out.write(`\x1b[H${tui.render().map(line => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
  let timer;
  const finish = () => {
    clearTimeout(timer);
    input.setRawMode(false);
    out.write("\x1b[?25h\x1b[?1049l");
    process.exit(0);
  };
  out.write("\x1b[?1049h\x1b[?25l");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  out.on("resize", draw);
  // Keys are handled one at a time, in order, even when an action awaits the server.
  let queue = Promise.resolve();
  input.on("data", data => {
    queue = queue.then(async () => {
      for (const name of keyNames(data)) {
        await tui.key(name);
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
