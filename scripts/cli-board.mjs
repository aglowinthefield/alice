// The board as a terminal sees it: the web board's lanes and card badges, as text. The badge rules come from the web
// app's src/model.ts (Node 24 strips its types), so the terminal and the browser cannot disagree on "Your turn".
import { cardActivity, needsYourReview, reviewActionText, reviewWaitText, waitingOn } from "../src/model.ts";
import { c, paint } from "./cli-style.mjs";

const blue = paint("34");
// Interrupted cards sit in Failed, as on the board.
export const lanes = [
  { status: "triage", label: "Triage", color: c.muted },
  { status: "ready", label: "Ready", color: c.info },
  { status: "running", label: "Running", color: c.warn },
  { status: "review", label: "Review", color: blue },
  { status: "failed", label: "Failed", color: c.bad, also: ["interrupted"] },
  { status: "done", label: "Done", color: c.ok },
  { status: "archived", label: "Archive", color: c.dim },
];
/** Done cards shown without --all; the rest are counted. */
export const doneShown = 5;

const visible = text => text.replace(/\x1b\[[\d;]*m/g, "");
const clip = (text, width) => text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

/** The badges the web board shows on a card, in its order, as coloured text. */
export function badges(card, cards, now = Date.now()) {
  const out = [];
  const activity = cardActivity(card, now);
  if (card.blocked) out.push(c.info(`waiting on ${waitingOn(card, cards).length}`));
  if (card.prNumber) out.push((card.prState === "CLOSED" || card.prChecks === "failing" ? c.bad : card.prState === "MERGED" ? c.ok : c.muted)(`PR #${card.prNumber}${card.prChecks && card.prState === "OPEN" ? ` · ${card.prChecks}` : ""}`));
  if (card.status === "done" && card.originMain === "local") out.push(c.warn("merged locally, not pushed"));
  if (card.status === "interrupted") out.push(c.warn("interrupted"));
  else if (card.status === "failed" && card.failureSummary) out.push(c.bad(card.failureSummary));
  else if (card.status === "review" && card.reviewWait) out.push(c.muted(reviewWaitText(card)));
  else if (needsYourReview(card)) out.push(c.bold(blue(reviewActionText(card) || "Your turn")));
  else if (activity === "quiet" && card.lastActivityAt) out.push(c.warn(`quiet ${Math.round((now - Date.parse(card.lastActivityAt)) / 60_000)}m`));
  else if (card.status === "running" && card.live) out.push(c.muted(`${card.live.tool} · turn ${card.live.turn}`));
  if (card.autoRetries) out.push(c.warn(`retry ${card.autoRetries}/3`));
  if (card.attempts > 1) out.push(c.warn(`${card.attempts} attempts`));
  return out;
}

/**
 * The whole board as rows: a count per lane, then each lane with cards. A card's row carries the card, so a TUI can
 * select it. Archive and old Done cards need `all`.
 */
export function boardRows(cards, { width = 80, now = Date.now(), all = false, title = "" } = {}) {
  const groups = lanes.map(lane => ({ ...lane, cards: cards.filter(card => card.status === lane.status || lane.also?.includes(card.status)) }));
  const rows = [];
  const tally = groups.filter(lane => all || lane.status !== "archived").map(lane => `${lane.color(lane.label)} ${lane.cards.length}`);
  const wide = tally.join(c.dim("  ·  "));
  if (title) rows.push({ text: c.bold(title) });
  rows.push({ text: visible(wide).length <= width ? wide : tally.join("  ") }, { text: "" });
  for (const lane of groups) {
    if (!lane.cards.length || (lane.status === "archived" && !all)) continue;
    let shown = lane.cards;
    if (lane.status === "done" && !all) shown = [...lane.cards].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, doneShown);
    rows.push({ text: `${lane.color("▍")}${c.bold(lane.color(lane.label))} ${c.dim(String(lane.cards.length))}`, lane: lane.status });
    for (const card of shown) {
      const tags = badges(card, cards, now).join(c.dim(" · "));
      const room = Math.max(20, width - 14 - visible(tags).length);
      rows.push({ text: `  ${c.dim(card.id.slice(0, 8))}  ${clip(card.title.replace(/\s+/g, " "), room)}${tags ? `  ${tags}` : ""}`, card, lane: lane.status });
    }
    if (shown.length < lane.cards.length) rows.push({ text: c.dim(`  … ${lane.cards.length - shown.length} more (--all)`) });
    rows.push({ text: "" });
  }
  return rows;
}

/** {@link boardRows} as plain lines, for `cards` on a terminal. */
export const renderBoard = (cards, options) => boardRows(cards, options).map(row => row.text);
