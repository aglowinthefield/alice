/**
 * Plain-text checks Alice runs on a card as it moves from Triage to Ready, before a paid run can start. They look for
 * asks only a person can meet (a physical device, screenshots by hand, staging or production), for a body that never
 * says what done looks like (the two kinds of card that reviewers send back most), and for a card too wide for one run
 * (many routes, files or surfaces, or a sweep like "migrate the remaining pages"), which takes about twice as many
 * attempts. The flags are advice; the card still moves with one more click, and a wide card can become a plan instead.
 */
export type ReadyFlag = {
  rule: "person-only" | "no-acceptance" | "wide";
  message: string;
  /** The text that tripped the rule, trimmed to about a line. */
  quote?: string;
};

const device = "Needs a physical device, which the agent does not have";
const handScreenshots = "Asks for screenshots or recordings made by hand";
const liveEnvironment =
  "Needs staging or production, which the agent cannot reach";
const person = "Asks for a check only a person can do";

const personOnly: { pattern: RegExp; message: string }[] = [
  {
    pattern:
      /\b(?:physical|real)\s+(?:i?phones?|ipads?|android\b(?:\s+(?:phones?|devices?|tablets?))?|devices?|handsets?|tablets?|apple\s+watch(?:es)?|hardware)\b/gi,
    message: device,
  },
  {
    pattern:
      /\bon\s+(?:a|an|my|your|the|their)\s+(?:i?phone|ipad|android\s+(?:phone|device|tablet)|apple\s+watch|mobile\s+device|test\s+device)s?\b/gi,
    message: device,
  },
  {
    pattern: /\b(?:device\s+runs?|on[- ]device|testflight)\b/gi,
    message: device,
  },
  {
    pattern:
      /\b(?:screenshots?|screen\s*shots?|screen\s+recordings?|recordings?)\s+(?:taken\s+|made\s+)?(?:by\s+hand|manually)\b/gi,
    message: handScreenshots,
  },
  {
    pattern:
      /\bmanual(?:ly)?\s+(?:take|capture|record|grab)?\s*(?:screenshots?|screen\s+recordings?)\b/gi,
    message: handScreenshots,
  },
  {
    pattern:
      /\b(?:verify|verified|test|tested|check|checked|confirm|confirmed|try|validate|validated|smoke[- ]?test|qa|reproduce|deploy|deployed|ship|release|run)\b[^.\n]{0,60}?\b(?:on|in|against|to|into)\s+(?:the\s+)?(?:staging|production|prod|live\s+(?:site|app|environment))\b(?!\s+(?:mode|build|bundle|config|settings|flag|env\s+var|dependencies))/gi,
    message: liveEnvironment,
  },
  {
    pattern: /\bstaging\s+(?:smoke|qa|run|check|verification)\b/gi,
    message: liveEnvironment,
  },
  {
    pattern:
      /\bmanual(?:ly)?\s+(?:test|verify|check|qa|confirm|click|try)\w*\b|\b(?:test|verify|check|confirm|try|qa)\b[^.\n]{0,40}?\bby\s+hand\b/gi,
    message: person,
  },
  {
    pattern:
      /\b(?:a\s+)?(?:human|person|someone|operator)\s+(?:needs?\s+to|must|should|has\s+to|will\s+need\s+to)\s+(?:verify|check|confirm|test|try|look|approve|sign)\w*\b|\b(?:get|needs?|requires?)\s+(?:a\s+)?sign[- ]?off\b|\b(?:get|needs?|requires?|wait\s+for)\s+(?:the\s+)?\w+'s\s+approval\b/gi,
    message: person,
  },
];

// Words just before a match that turn the ask around: "no device runs needed", "do not deploy to staging".
const negation =
  /\b(?:no|not|don't|dont|do\s+not|never|without|instead\s+of|rather\s+than|avoid|skip|no\s+need\s+(?:to|for))\b[^.\n]{0,30}$/i;

// Ways a body says what done looks like: a section heading or label, a checklist, or a sentence about the outcome.
const acceptance = [
  /^\s*(?:#{1,6}\s+|[-*+]\s+)?(?:\*\*|__)?\s*(?:acceptance|criteria|done\s+when|definition\s+of\s+done|success\s+criteria|expected\s+(?:results?|behaviou?r|outcomes?)|verification|how\s+to\s+(?:test|verify)|test\s+plan|tests?)\b/im,
  /^\s*[-*+]\s+\[[ xX]\]/m,
  /^\s*(?:[-*+]\s+)?(?:\*\*)?AC\d+\b/m,
  /\b(?:acceptance\s+criteri(?:a|on)|done\s+when|definition\s+of\s+done|should|must|expect(?:s|ed)?|so\s+that|tests?\s+(?:cover|pass|prove|show|check|fail)\w*)\b/i,
  /\bgiven\b[^.\n]*\bwhen\b[^.\n]*\bthen\b/i,
];

/** Code blocks often hold commands and config that name staging or devices without asking for them. */
function prose(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

/** The match with up to 40 characters either side, kept within its line. */
function quoteAround(text: string, index: number, length: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const newline = text.indexOf("\n", index + length),
    lineEnd = newline === -1 ? text.length : newline;
  const start = Math.max(lineStart, index - 40),
    end = Math.min(lineEnd, index + length + 40);
  return `${start > lineStart ? "…" : ""}${text.slice(start, end).trim()}${end < lineEnd ? "…" : ""}`;
}

/**
 * The flags to show as a card moves to Ready. Only Triage cards are checked: a card that already ran was committed to
 * before.
 */
export function readyFlags(card: {
  title: string;
  body: string;
  status: string;
}): ReadyFlag[] {
  return card.status === "triage" ? lintCard(card) : [];
}

/** Flags for a card's text, at most one per message. An empty list means nothing stood out. */
export function lintCard(card: { title: string; body: string }): ReadyFlag[] {
  const text = prose(`${card.title}\n${card.body ?? ""}`);
  const flags: ReadyFlag[] = [];
  // Text a rule already flagged, so the general rules below do not report "screenshots by hand" a second time.
  const flagged: [number, number][] = [];
  for (const { pattern, message } of personOnly) {
    if (flags.some((flag) => flag.message === message)) continue;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0,
        end = index + match[0].length;
      if (flagged.some(([from, to]) => index < to && end > from)) continue;
      if (negation.test(text.slice(Math.max(0, index - 40), index))) continue;
      flags.push({
        rule: "person-only",
        message,
        quote: quoteAround(text, index, match[0].length),
      });
      flagged.push([index, end]);
      break;
    }
  }
  const width = estimateWidth(card);
  if (width.wide)
    flags.push({
      rule: "wide",
      message: `Looks too wide for one run (${width.reasons.join(", ")}): cards like this often take several attempts, so consider turning it into a plan`,
      ...(width.quote ? { quote: width.quote } : {}),
    });
  const body = prose(card.body ?? "");
  if (!acceptance.some((pattern) => pattern.test(body)))
    flags.push({
      rule: "no-acceptance",
      message: body.trim()
        ? "No acceptance criteria: say what done looks like, for example under an Acceptance heading"
        : "The card has no description, so nothing says what done looks like",
    });
  return flags;
}

/** What the width estimate found: the counts behind it, and whether they add up to a card too wide for one run. */
export type Width = {
  wide: boolean;
  routes: number;
  files: number;
  surfaces: string[];
  listItems: number;
  /** A phrase asking to sweep a whole kind of thing, such as "migrate the remaining pages". */
  sweep: { strong: boolean; text: string } | null;
  /** Short reasons for the flag, such as "10 routes"; empty when the card is not wide. */
  reasons: string[];
  quote?: string;
};

// Counts at or above `strong` flag a card alone; at or above `some` they flag it with another sign of width. Files never
// flag a card alone: on Alice's own history, careful briefs that name a dozen files took no more runs than the rest.
const limits = {
  routes: { some: 3, strong: 5 },
  files: { some: 8, strong: Infinity },
  surfaces: { some: 4, strong: 5 },
  listItems: { some: 8, strong: 12 },
};

// URL paths such as `/settings` or `/api/boards/:id`; the lookbehind skips "and/or", fractions and full URLs.
const routePattern =
  /(?<![\w.~/:-])\/[a-z0-9:{[_][\w:{}[\].*-]*(?:\/[\w:{}[\].*-]+)*\/?/gi;
const filesystemRoot =
  /^\/(?:home|users|tmp|usr|etc|var|opt|private|mnt|dev|proc|bin|sbin|lib|volumes|applications|library|system)(?:\/|$)/i;
const filePattern =
  /(?<![\w./-])(?:[\w@.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html|md|mdx|py|rb|go|rs|swift|kt|java|sql|ya?ml|toml|sh|vue|svelte|astro|php|cs|c|h|cpp)\b/g;
// Library names written like file names.
const notAFile =
  /^(?:node|next|vue|react|nuxt|express|three|d3|chart|moment|ember|backbone|angular|solid|alpine|socket\.io|p5|pixi|fabric)\.js$/i;
const surfacePatterns: [string, RegExp][] = [
  ["web", /\b(?:web\s*(?:ui|app|board|page|client)?|browser|front[- ]?end)\b/i],
  ["CLI", /\b(?:cli|command[- ]line)\b/i],
  ["TUI", /\btui\b/i],
  ["server", /\b(?:server|back[- ]?end|api|endpoints?)\b/i],
  ["desktop", /\b(?:desktop|tauri|electron)\b/i],
  ["iOS", /\bios\b/i],
  ["Android", /\bandroid\b/i],
  ["database", /\b(?:database|sqlite|postgres(?:ql)?|mysql)\b/i],
  ["docs", /\b(?:docs|documentation|readme)\b/i],
  ["email", /\bemails?\b/i],
];
// Kinds of thing a card might sweep across; tests are left out, since "all tests pass" is an acceptance line.
const things =
  "(?:routes?|pages?|screens?|views?|endpoints?|handlers?|files?|modules?|components?|callers?|call[- ]sites?|usages?|uses|places|instances|tables|models|services|packages|repos(?:itories)?|surfaces|dialogs|forms|commands|features|apps|templates|queries|controllers|jobs|workers|lanes|boards)";
const sweepWords = `(?:all(?:\\s+(?:of\\s+)?the)?|every|each|the\\s+(?:remaining|rest\\s+of\\s+the|other))\\s+(?:\\w+\\s+){0,2}?(?:remaining\\s+)?${things}\\b|\\bthe\\s+remaining\\s+(?:\\w+\\s+){0,2}?${things}\\b|\\b(?:across|throughout)\\s+the\\s+(?:whole\\s+|entire\\s+)?(?:codebase|app|repo(?:sitory)?|monorepo|product)\\b|\\beverywhere\\b`;
const sweepPattern = new RegExp(`\\b(?:${sweepWords})`, "gi");
// A sweep paired with a verb that moves code wholesale is wide on its own.
const migrateVerbs =
  /\b(?:migrate|migrating|convert|converting|port|porting|move|moving|rewrite|rewriting|replace|replacing|update|updating|switch|switching|upgrade|upgrading|refactor|refactoring|redesign|restyle|apply|roll\s+out)\b[^.\n]{0,40}$/i;
// The section headings under which a list says what done looks like rather than what to change.
const doneHeading =
  /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?\s*(?:acceptance|criteria|done\s+when|definition\s+of\s+done|success\s+criteria|expected|verification|how\s+to\s+(?:test|verify)|test\s+plan|tests?|follow[- ]?ups?|notes?|context|background|evidence|data|why)\b/i;

/** The body without the sections that describe done, context or follow-ups: the part that says what to change. */
function workText(body: string): string {
  let counting = true;
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    if (
      /^\s*#{1,6}\s/.test(line) ||
      /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__):?\s*$/.test(line) ||
      /^\s*[\w ]{2,30}:\s*$/.test(line)
    )
      counting = !doneHeading.test(line);
    else if (counting) kept.push(line);
  }
  return kept.join("\n");
}

/** A card already asking for a plan: the text "Turn into a plan" writes, an alice-plan block, or a title starting "Plan". */
export function isPlanningCard(card: { title: string; body: string }): boolean {
  return (
    /^\s*(?:plan|break\s+down|split)\b/i.test(card.title) ||
    /\balice-plan\b|\b(?:do\s+not|don't)\s+implement\b/i.test(card.body ?? "")
  );
}

/**
 * Estimates from the card text whether the work is too wide for one run. Wide migrations and cross-surface features took
 * about twice as many attempts as other cards and outgrew auto-review. Signs: many distinct routes, files or surfaces,
 * a long list of things to change, and sweeping words ("every page", "migrate the remaining routes"). One strong sign
 * flags a card; so do two weaker ones. Cards that already ask for a plan are never wide.
 */
export function estimateWidth(card: { title: string; body: string }): Width {
  const text = prose(`${card.title}\n${card.body ?? ""}`);
  const routes = new Set<string>(),
    files = new Set<string>();
  for (const [match] of text.matchAll(routePattern)) {
    const route = match.replace(/\/$/, "").toLowerCase();
    if (filesystemRoot.test(route) || /\.\w{1,5}$/.test(route)) continue;
    routes.add(route);
  }
  for (const [match] of text.matchAll(filePattern))
    if (!notAFile.test(match)) files.add(match.toLowerCase());
  // Paths such as `server/board.ts` name a file, not the server as a surface.
  const words = text.replace(filePattern, " ").replace(routePattern, " ");
  const surfaces = surfacePatterns
    .filter(([, pattern]) => pattern.test(words))
    .map(([name]) => name);
  const work = `${card.title}\n${workText(prose(card.body ?? ""))}`;
  const listItems = work
    .split("\n")
    .filter((line) =>
      /^\s*(?:[-*+]|\d+[.)])\s+(?!\[[ xX]\])\S/.test(line),
    ).length;
  // Acceptance lines such as "each route renders" describe done, not the scope, so only the work part counts.
  let sweep: Width["sweep"] = null,
    quote: string | undefined;
  for (const match of work.matchAll(sweepPattern)) {
    const index = match.index ?? 0;
    const before = work.slice(Math.max(0, index - 60), index);
    if (negation.test(before.slice(-40))) continue;
    const strong = migrateVerbs.test(before);
    if (!sweep || (strong && !sweep.strong)) {
      sweep = { strong, text: match[0] };
      quote = quoteAround(work, index, match[0].length);
    }
    if (strong) break;
  }
  const counts = [
    [routes.size, limits.routes, "routes"],
    [files.size, limits.files, "files"],
    [surfaces.length, limits.surfaces, "surfaces"],
    // A list of routes or files is already counted above.
    [
      routes.size >= limits.routes.some || files.size >= limits.files.some
        ? 0
        : listItems,
      limits.listItems,
      "items to change",
    ],
  ] as const;
  const reasons: string[] = [];
  let strong = 0,
    some = 0;
  for (const [count, limit, noun] of counts) {
    if (count >= limit.strong) strong++;
    else if (count >= limit.some) some++;
    else continue;
    reasons.push(
      noun === "surfaces"
        ? `${count} surfaces: ${surfaces.join(", ")}`
        : `${count} ${noun}`,
    );
  }
  if (sweep) {
    if (sweep.strong) strong++;
    else some++;
    reasons.push(`“${sweep.text}”`);
  }
  const wide = !isPlanningCard(card) && (strong > 0 || some >= 2);
  return {
    wide,
    routes: routes.size,
    files: files.size,
    surfaces,
    listItems,
    sweep,
    reasons: wide ? reasons : [],
    ...(wide && quote ? { quote } : {}),
  };
}

/**
 * The card rewritten to ask for a plan instead of code, keeping its words as the brief. A run on it ends with the
 * alice-plan block Alice turns into Triage cards, the same flow as any card that asks for a breakdown.
 */
export function planningCard(card: { title: string; body: string }): {
  title: string;
  body: string;
} {
  const title = /^\s*plan\b/i.test(card.title)
    ? card.title
    : `Plan: ${card.title}`;
  return {
    title: title.slice(0, 200),
    body: `Plan this work; do not implement it. Read the code it touches and break it into small cards, each one agent run that touches a few files on one surface, ordered so cards that edit the same files depend on each other. Finish with the alice-plan block.\n\n## The work to plan\n\n${card.body ?? ""}`.trimEnd(),
  };
}
