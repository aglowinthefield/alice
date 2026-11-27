/**
 * Plain-text checks Alice runs on a card as it moves from Triage to Ready, before a paid run can start. They look for
 * asks only a person can meet (a physical device, screenshots by hand, staging or production) and for a body that never
 * says what done looks like: the two kinds of card that reviewers send back most. The flags are advice; the card still
 * moves with one more click.
 */
export type ReadyFlag = {
  rule: "person-only" | "no-acceptance";
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
 * before. Sentinel cards are skipped too, since Alice wrote their text from its own template.
 */
export function readyFlags(card: {
  title: string;
  body: string;
  status: string;
  sentinelId?: string | null;
}): ReadyFlag[] {
  return card.status === "triage" && !card.sentinelId ? lintCard(card) : [];
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
