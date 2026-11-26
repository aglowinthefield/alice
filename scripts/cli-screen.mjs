// A terminal screen as a grid of cells, each one character and its SGR style ("1;33"). The TUI draws into it and
// prints it as lines. Every character owns its columns, so a wide emoji or an odd glyph in a card title can't push the
// rest of a row sideways, and boxes, dimming and clipping work per cell.

const graphemes = new Intl.Segmenter();
const WIDE = /\p{Emoji_Presentation}|\uFE0F|[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
// Server text can carry escape sequences or line breaks; on a terminal they would move the cursor.
const clean = text => String(text).replace(/[\t\n\r]/g, " ").replace(/\p{Cc}/gu, "");
const split = text => [...graphemes.segment(clean(text))].map(({ segment }) => [segment, /^\p{Cf}+$/u.test(segment) ? 0 : WIDE.test(segment) ? 2 : 1]);

/** The terminal columns `text` takes. */
export const width = text => split(text).reduce((sum, [, w]) => sum + w, 0);

/** `text` cut to `max` columns, ending in … when cut. */
export function clip(text, max) {
  if (width(text) <= max) return clean(text);
  let out = "", used = 0;
  for (const [g, w] of split(text)) {
    if (used + w > max - 1) break;
    out += g; used += w;
  }
  return max > 0 ? `${out}…` : "";
}

/** Word-wraps `text` to `max` columns. With `lines`, the last line takes the rest of the text and is clipped. */
export function wrap(text, max, lines = Infinity) {
  const out = [];
  let line = "";
  for (const word of clean(text).split(" ").filter(Boolean)) {
    if (line && width(line) + 1 + width(word) > max) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  if (out.length > lines) out.splice(lines - 1, Infinity, out.slice(lines - 1).join(" "));
  return out.map(item => clip(item, max));
}

export class Screen {
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: columns }, () => [" ", ""]));
  }

  /** Writes `text` in one style from column `x` of row `y`, clipped at the edges. Returns the column after it. */
  put(x, y, text, style = "") {
    const row = this.cells[y];
    for (const [g, w] of split(text)) {
      if (!w) continue;
      if (row && x >= 0 && x + w <= this.columns) {
        // Writing over half of a wide character blanks its other half.
        if (row[x][0] === "" && x > 0) row[x - 1] = [" ", row[x - 1][1]];
        if (w === 1 && row[x + 1]?.[0] === "") row[x + 1] = [" ", row[x + 1][1]];
        row[x] = [g, style];
        if (w === 2) row[x + 1] = ["", style];
      }
      x += w;
    }
    return x;
  }

  /** Writes styled parts one after another: `[[text, style], …]`. */
  parts(x, y, list) {
    for (const [text, style] of list) x = this.put(x, y, text, style);
    return x;
  }

  /** Blanks a rectangle, as a dialog does over the board behind it. */
  clear(x, y, w, h) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.cells[j]?.[i]) this.cells[j][i] = [" ", ""];
  }

  box(x, y, w, h, style = "", heavy = false) {
    const [tl, tr, bl, br, across, down] = heavy ? ["┏", "┓", "┗", "┛", "━", "┃"] : ["╭", "╮", "╰", "╯", "─", "│"];
    this.put(x, y, tl + across.repeat(w - 2) + tr, style);
    for (let i = 1; i < h - 1; i++) { this.put(x, y + i, down, style); this.put(x + w - 1, y + i, down, style); }
    this.put(x, y + h - 1, bl + across.repeat(w - 2) + br, style);
  }

  /** Fades everything drawn so far, for what sits behind a dialog. */
  dim() {
    for (const row of this.cells) for (const cell of row) cell[1] = "2";
  }

  /** The rows as text, with SGR codes when `color` is on. */
  lines(color = false) {
    return this.cells.map(row => {
      let out = "", current = "";
      for (const [g, style] of row) {
        if (color && style !== current) { out += current ? "\x1b[0m" : ""; out += style ? `\x1b[${style}m` : ""; current = style; }
        out += g;
      }
      return color && current ? `${out}\x1b[0m` : out;
    });
  }
}
