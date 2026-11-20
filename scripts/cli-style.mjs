// Terminal styling for bakery-cli. Layout and colour only on a terminal, so scripts and agents that pipe the output
// keep the plain tab-separated lines. NO_COLOR drops the colour but keeps the layout; FORCE_COLOR wins over both.

const forced = () => process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "";
export const pretty = (stream = process.stdout) => forced() ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY);
export const useColor = (stream = process.stdout) => forced() ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY) && !process.env.NO_COLOR;

export const paint = (code, stream = process.stdout) => text => useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;

// Frosting, cream and crust.
export const c = {
  bold: paint("1"), dim: paint("2"), head: paint("1;38;5;217"), cmd: paint("38;5;218"), arg: paint("38;5;180"),
  ok: paint("38;5;114"), warn: paint("38;5;221"), bad: paint("38;5;174"), info: paint("38;5;117"), muted: paint("38;5;245"),
};

const visible = text => text.replace(/\x1b\[[\d;]*m/g, "");
export const pad = (text, width) => text + " ".repeat(Math.max(1, width - visible(text).length));
export const columns = () => process.stdout.columns || Number(process.env.COLUMNS) || 80;

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
const SHADES = [174, 174, 218, 218, 217, 223, 223, 223, 180, 180];

export function banner(version) {
  const beside = ["", "", "", "", c.bold("b a k e r y"), c.dim("Pi agents bake your cards, one worktree each."), version ? c.dim(version) : "", "", "", ""];
  return CAKE.map((row, i) => `  ${paint(`38;5;${SHADES[i]}`)(row)}${beside[i] ? `   ${beside[i]}` : ""}`).join("\n");
}

// Pipe-friendly lines laid out for a person: tab-separated runs of lines become aligned columns, statuses get their
// lane's colour, and "key:value" cells dim the key.
const STATUS = {
  triage: c.muted, ready: c.info, running: c.warn, review: paint("38;5;183"), failed: c.bad, interrupted: paint("38;5;215"),
  done: c.ok, archived: c.dim, error: c.bad, enabled: c.ok, paused: c.warn, succeeded: c.ok, blocked: c.bad,
  PASS: c.ok, WARN: c.warn, FAIL: c.bad, on: c.ok, off: c.muted,
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
    for (const row of rows) row.slice(0, -1).forEach((text, i) => { widths[i] = Math.max(widths[i] ?? 0, text.length); });
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
