// Terminal styling for bakery-cli. Layout and colour only on a terminal, so scripts and agents that pipe the output
// keep the plain tab-separated lines. NO_COLOR drops the colour but keeps the layout; FORCE_COLOR wins over both.

const forced = () => process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "";
export const pretty = (stream = process.stdout) => forced() ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY);
export const useColor = (stream = process.stdout) => forced() ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY) && !process.env.NO_COLOR;

export const paint = (code, stream = process.stdout) => text => useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;

// The terminal's own 16 colours, so the theme picks shades that read on a light or a dark background.
// Help is yellow like the crust, with arguments dimmed (house-style references/cli.md).
export const c = {
  bold: paint("1"), dim: paint("2"), head: paint("1;33"), cmd: paint("33"), arg: paint("2"),
  ok: paint("32"), warn: paint("33"), bad: paint("31"), info: paint("36"), muted: paint("2"),
};

const visible = text => text.replace(/\x1b\[[\d;]*m/g, "");
export const pad = (text, cols) => text + " ".repeat(Math.max(1, cols - width(visible(text))));
export const columns = () => process.stdout.columns || Number(process.env.COLUMNS) || 80;

/**
 * Text from the server made safe for one terminal line or one tab-separated field: escape sequences are dropped, and
 * tabs, line breaks and other control characters become single spaces.
 */
export const plain = text => String(text ?? "")
  .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g, "")
  .replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ");

const graphemes = new Intl.Segmenter();
// East Asian wide and fullwidth characters and emoji take two columns; combining marks and format characters none.
const wide = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f/u;
const cells = grapheme => wide.test(grapheme) ? 2 : /^[\p{M}\p{Cf}]*$/u.test(grapheme) ? 0 : 1;
/** Terminal columns plain text takes. */
export function width(text) {
  let total = 0;
  for (const { segment } of graphemes.segment(text)) total += cells(segment);
  return total;
}
/** Plain text cut to `cols` terminal columns, ending in … when cut. */
export function clip(text, cols) {
  if (width(text) <= cols) return text;
  let out = "", used = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (used + cells(segment) > cols - 1) break;
    out += segment; used += cells(segment);
  }
  return cols > 0 ? `${out}…` : "";
}

/** The keys in one chunk of terminal input: a fast typist or a pasted "jjq" arrives as one chunk. */
export const keyPresses = data => String(data).match(/\x1b\[[\d;]*[~A-Za-z]|\x1bO[A-Za-z]|[\s\S]/gu) ?? [];

/** `--watch`'s last line in `cols` columns: the problem from the last fetch, on one line, or when it updated and the keys. */
export function footer({ problem = "", updated = "", scrolls = false }, cols) {
  if (problem) return c.bad(clip(plain(problem).trim(), cols));
  return c.dim(clip(`${scrolls ? updated : `updated ${updated}`} · ${scrolls ? "j/k scroll · " : ""}q to quit`, cols));
}

/**
 * The part of a screen of `rows` lines that `--watch` draws above its footer: `head` stays put and `body` scrolls,
 * starting at `offset` clamped so the last row can be reached but not passed. `top` is the clamped offset.
 */
export function frame({ head = [], body }, rows, offset) {
  const room = Math.max(1, rows - head.length - 1);
  const top = Math.max(0, Math.min(offset, body.length - room));
  return { top, scrolls: body.length > room, lines: [...head, ...body.slice(top, top + room)] };
}

export function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

// A slice of cake in braille dots, coloured from cherry down to the crust.
const CAKE = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⣤⣞⠋⠉⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡏⠀⠋⠘⡇⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⣠⡴⢿⡻⠦⠤⢞⣉⡷⢦⣀⠀⠀",
  "⠀⠀⠀⠀⢀⡴⠚⠁⠀⠀⣧⡤⠤⠾⠀⠀⣀⣈⣷⣦",
  "⠀⢀⡴⠞⣁⣀⣀⣠⡤⠤⠤⠶⠒⠛⠉⠉⠉⠀⠀⢸",
  "⡾⠛⠛⠉⠉⠉⠁⠀⠀⠀⠀⠀⢀⣠⣄⡀⣴⠖⠢⣼",
  "⡇⣠⣤⡀⢠⠴⠲⠤⠴⠋⢹⡆⡟⠀⣸⣇⣇⣤⡤⣼",
  "⡿⠁⠀⣇⣼⣀⣠⡤⠴⠶⠞⠧⠟⠉⠉⠉⠀⠀⠀⢸",
  "⡟⠛⠉⠉⠀⠀⠀⠀⠀⢀⣀⣠⣤⡤⠴⠖⠒⠚⠛⠉",
  "⣧⡤⠤⠴⠶⠒⠛⠉⠉⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
];
const SHADES = [31, 31, 35, 35, 35, 33, 33, 33, 33, 33];

export function banner(version) {
  const beside = ["", "", "", "", c.bold("b a k e r y"), "Pi agents bake your cards, one worktree each.", version ? c.dim(version) : "", "", "", ""];
  return CAKE.map((row, i) => `  ${paint(String(SHADES[i]))(row)}${beside[i] ? `   ${beside[i]}` : ""}`).join("\n");
}

// Pipe-friendly lines laid out for a person: tab-separated runs of lines become aligned columns, statuses get their
// lane's colour, and "key:value" cells dim the key.
const STATUS = {
  triage: c.muted, ready: c.info, running: c.warn, review: paint("34"), failed: c.bad, interrupted: c.warn,
  done: c.ok, archived: c.dim, error: c.bad, enabled: c.ok, paused: c.warn, succeeded: c.ok, blocked: c.bad,
  PASS: c.ok, WARN: c.warn, FAIL: c.bad, INFO: c.muted, on: c.ok, off: c.muted,
};
const cell = text => {
  if (STATUS[text]) return STATUS[text](text);
  const pair = /^([a-z][\w -]*):(\S.*)$/.exec(text);
  if (pair) return `${c.dim(`${pair[1]}:`)}${STATUS[pair[2]] ? STATUS[pair[2]](pair[2]) : pair[2]}`;
  return text;
};

export function layout(lines) {
  const out = [];
  let group = [];
  const flush = () => {
    const rows = group.map(line => line.split("\t"));
    const widths = [];
    for (const row of rows) row.slice(0, -1).forEach((text, i) => { widths[i] = Math.max(widths[i] ?? 0, width(text)); });
    for (const row of rows) out.push(row.map((text, i) => i < row.length - 1 ? pad(cell(text), widths[i] + 2) : cell(text)).join("").trimEnd());
    group = [];
  };
  for (const line of lines) {
    if (line.includes("\t")) group.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out;
}
