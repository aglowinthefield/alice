// The board as a terminal sees it: the web board's lanes and card badges, as text. The badge rules come from
// shared/card-state.ts, which the web app uses too (Node 24 strips its types), so the terminal and the browser
// cannot disagree on "Your turn".
import { cardActivity, needsYouStatuses, needsYourReview, reviewActionText, reviewWaitText, waitingOn } from "../shared/card-state.ts";
import { repoName } from "../src/repo-appearance.ts";
import { c, clip, paint, plain, width } from "./cli-style.mjs";

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
      rows.push({ text: `  ${c.dim(card.id.slice(0, 8))}  ${clip(plain(card.title), room)}${tags ? `  ${tags}` : ""}`, card, lane: lane.status });
    }
    if (shown.length < lane.cards.length) rows.push({ text: c.dim(`  … ${lane.cards.length - shown.length} more (--all)`) });
    rows.push({ text: "" });
  }
  return rows;
}

/** {@link boardRows} as plain lines, for `cards` on a terminal. */
export const renderBoard = (cards, options) => boardRows(cards, options).map(row => row.text);

/** How long ago an ISO time was: "42s", "12m" or "1h 5m"; "" when it is not a time. */
export function elapsed(since, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

const kinds = { run: { label: "run", color: c.warn }, review: { label: "review", color: blue }, draft: { label: "PR draft", color: c.info }, pr: { label: "opening PR", color: c.ok } };
const yourStep = card => card.status === "review" ? { label: reviewActionText(card) || "Your turn", color: text => c.bold(blue(text)) }
  : card.status === "failed" ? { label: "failed", color: c.bad } : { label: "interrupted", color: c.warn };
const plural = (count, word) => count ? `${count} ${word}${count === 1 ? "" : "s"}` : "";

/**
 * Every board at once, for `running`. `work` is `/api/running`, the server's scheduler state: the runs, agent reviews,
 * PR drafts and automatic PR openings going now, shown longest first, and those it has queued (hook fixes waiting for a
 * run slot, drafts waiting for a drafting slot, cards waiting to have their PR opened). Then the cards waiting for you,
 * as Today lists them, leaving out cards Alice is handling itself (every card in `work` but a PR draft, which only
 * prepares the Approve dialog) and cards whose start is queued; and how many will start without you: those queued
 * items, Ready cards on boards with pickup on, queued starts and agent reviews in line.
 */
export function runningView(work, cards, boards) {
  const busy = new Set(work.map(item => item.cardId));
  const handled = new Set(work.filter(item => item.kind !== "draft").map(item => item.cardId));
  const pickup = new Set(boards.filter(item => item.autoPickupEnabled).map(item => item.repo));
  const waiting = cards.filter(card => needsYouStatuses.includes(card.status) && !handled.has(card.id) && !card.startQueued && (card.status !== "review" || needsYourReview(card)))
    .sort((a, b) => needsYouStatuses.indexOf(a.status) - needsYouStatuses.indexOf(b.status) || (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
  const later = cards.filter(card => !busy.has(card.id));
  const queued = kind => work.filter(item => item.queued && item.kind === kind).length;
  const runs = later.filter(card => card.startQueued || (card.status === "ready" && !card.blocked && pickup.has(card.repo))).length + queued("run");
  const reviews = later.filter(card => card.reviewWait === "agent_review" && card.reviewQueue).length;
  const drafts = queued("draft"), prs = queued("pr");
  return {
    active: work.filter(item => !item.queued).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    waiting, queued: { total: runs + reviews + drafts + prs, runs, reviews, drafts, prs },
  };
}

/**
 * An item's second line in `room` columns: the tag and the short `fixed` fields in full, then the repository and the
 * free `text` sharing what is left, the repository taking at most half unless the text is shorter. So a long
 * repository name cannot push the time or the tool off the line.
 */
function detail(tag, repo, fixed, text, room) {
  fixed = fixed.filter(Boolean);
  const left = room - width(tag.label) - fixed.reduce((sum, field) => sum + width(field) + 3, 0) - 3 - (text ? 3 : 0);
  const shown = clip(repo, text ? Math.max(Math.ceil(left / 2), left - width(text)) : left);
  const fields = [shown, ...fixed, clip(text, left - width(shown))].filter(Boolean);
  return `  ${tag.color(tag.label)}${c.dim(fields.map(field => ` · ${field}`).join(""))}`;
}

/** {@link runningView} for a narrow pane: two lines per item, the card's title and then what it is doing. */
export function renderRunning({ active, waiting, queued }, { width: cols = 40, now = Date.now() } = {}) {
  const room = Math.max(10, cols - 2);
  const heading = (label, color, count) => `${color("▍")}${c.bold(color(label))} ${c.dim(String(count))}`;
  const lines = [heading("Running", c.warn, active.length)];
  for (const work of active) {
    lines.push(`  ${clip(plain(work.title), room)}`,
      detail(kinds[work.kind] ?? { label: plain(work.kind), color: c.muted }, repoName(plain(work.repo)), [elapsed(work.startedAt, now)], plain(work.tool) || "starting", room));
  }
  lines.push("", heading("Waiting for you", blue, waiting.length));
  for (const card of waiting) lines.push(`  ${clip(plain(card.title), room)}`, detail(yourStep(card), repoName(plain(card.repo)), [], card.status === "failed" ? plain(card.failureSummary) : "", room));
  const parts = [plural(queued.runs, "run"), plural(queued.reviews, "review"), plural(queued.drafts, "draft"), plural(queued.prs, "PR")].filter(Boolean).join(" · ");
  const head = `Queued ${queued.total}`;
  lines.push("", `${heading("Queued", c.info, queued.total)}${parts ? c.dim(`  ${clip(parts, room - width(head) - 1)}`) : ""}`);
  return lines;
}

/**
 * {@link renderRunning} for `--watch` on a screen of `rows` lines. When it does not fit, the three counts stay pinned
 * above the list, which scrolls (see `frame` in cli-style.mjs).
 */
export function runningScreen(view, { rows = 24, ...options } = {}) {
  const body = renderRunning(view, options);
  if (body.length <= rows - 1) return { head: [], body };
  const count = (label, color, n) => `${c.bold(color(label))} ${n}`;
  return { head: [[count("Running", c.warn, view.active.length), count("Waiting", blue, view.waiting.length), count("Queued", c.info, view.queued.total)].join(c.dim(" · "))], body };
}

/** {@link runningView} as tab-separated lines for a pipe, each led by its section, with every field on one line. */
export const runningLines = ({ active, waiting, queued }, now = Date.now()) => [
  ...active.map(work => ["running", work.kind, work.cardId, work.repo, elapsed(work.startedAt, now) || "-", work.tool || "-", work.title].map(plain).join("\t")),
  ...waiting.map(card => ["waiting", card.id, card.repo, yourStep(card).label, card.title].map(plain).join("\t")),
  `queued\t${queued.total}\truns:${queued.runs}\treviews:${queued.reviews}\tdrafts:${queued.drafts}\tprs:${queued.prs}`,
];
