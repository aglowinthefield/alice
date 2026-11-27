// Every command bakery-cli knows, and the help it prints. Adding a command means adding an entry here;
// tests/bakery-cli.test.ts checks that the commands the CLI runs and the ones listed here are the same.
import { banner, c, columns, pad, pretty, wrap } from "./cli-style.mjs";

const BOARD = ["--board ID|PATH", "the board (default: the one whose repository holds the current directory, or the only one)"];
const JSON_OUT = ["--json", "print the full API data"];
const SOURCE = ["--source NAME", "where the card came from (default: cli); agents give their name"];
const PRIORITY = ["--priority P", "-100 to 100, or low, normal, high or urgent (default: normal)"];

export const GROUPS = ["Cards", "Runs", "Tidy up", "Boards", "Sentinels", "Setup"];

export const COMMANDS = [
  {
    name: "add", group: "Cards", args: "TITLE...", summary: "quick capture: a new Triage card",
    full: "TITLE... [--body BODY] [--priority P] [--source NAME] [--board ID|PATH] [--json]",
    details: "The words after add become the title.",
    options: [["--body BODY", "the description"], PRIORITY, SOURCE, BOARD, JSON_OUT],
    examples: [["bakery-cli add Fix the flaky login test", ""], ["bakery-cli add Ship it --priority urgent", ""]],
  },
  {
    name: "create", group: "Cards", args: "--title TITLE", summary: "a new card, with a key or dependencies",
    full: "--title TITLE [--body BODY] [--key KEY] [--priority P] [--source NAME] [--after CARD_ID]... [--board ID|PATH] [--json]",
    details: "--key KEY (up to 200 characters) is idempotent per board: if a card with that key exists, in any status, it is printed instead of creating another.\n--after CARD_ID (repeatable) makes the new card wait until each named card is Done or archived.\n--source NAME records where the card came from, shown on its Details tab; it defaults to cli. Agents name themselves, for example --source hermes.",
    options: [["--title TITLE", "the title"], ["--body BODY", "the description"], ["--key KEY", "create once per board; later calls print the same card"], PRIORITY, SOURCE, ["--after CARD_ID", "wait for that card first (repeatable)"], BOARD, JSON_OUT],
    examples: [["bakery-cli create --title 'Add the API' --key gh-42/t1", ""], ["bakery-cli create --title 'Use the API' --after CARD_ID", "start only after CARD_ID is done"]],
  },
  {
    name: "cards", group: "Cards", summary: "the board's lanes and cards",
    full: "[--board ID|PATH] [--all] [--watch] [--json]",
    options: [BOARD, ["--all", "include Archive and every Done card"], ["--watch", "redraw every 2 seconds until q; j/k scroll (terminal only)"], JSON_OUT],
    details: "On a terminal, cards print in the board's lanes with its badges. Piped, each card is one tab-separated line.",
  },
  {
    name: "tui", group: "Cards", summary: "the board in the terminal, driven by keys",
    full: "[--board ID|PATH]", options: [BOARD],
    details: "Arrow keys or j/k move between cards, enter opens one, o opens it in the browser and ? lists every key. s starts a run, x stops one, a approves, r and t move between Ready and Triage. Paid runs and merges ask first. Refreshes every 2 seconds; q quits.",
  },
  {
    name: "open", group: "Cards", args: "[CARD_ID]", summary: "open the board, or a card, in the browser",
    full: "[CARD_ID] [--board ID|PATH] [--print] [--json]",
    details: "CARD_ID may be the 8-character ID the other commands print. Uses $BROWSER when set, else the system's opener, and always prints the URL; with no display (over SSH) it only prints. With several boards and none chosen, it opens Bakery's home page.",
    options: [["--print", "print the URL without opening it"], BOARD, JSON_OUT],
  },
  {
    name: "show", group: "Cards", args: "CARD_ID", summary: "a card with its dependencies, attempts and review",
    full: "CARD_ID [--board ID|PATH] [--json]",
    details: "Prints the card with its dependencies, dependents, attempts and latest auto-review.",
    options: [BOARD, JSON_OUT],
  },
  {
    name: "edit", group: "Cards", args: "CARD_ID", summary: "change a card's title or description",
    full: "CARD_ID [--title TITLE] [--body BODY] [--board ID|PATH] [--json]",
    options: [["--title TITLE", "the new title"], ["--body BODY", "the new description (may be empty)"], BOARD, JSON_OUT],
  },
  {
    name: "depend", group: "Cards", args: "CARD_ID --on CARD_ID...", summary: "make a card wait for others",
    full: "CARD_ID --on CARD_ID... [--board ID|PATH] [--json]",
    details: "A card waiting on an unfinished dependency is not picked up, and start refuses it until its dependencies are Done.",
    options: [["--on CARD_ID", "the card to wait for (repeatable)"], BOARD, JSON_OUT],
  },
  {
    name: "undepend", group: "Cards", args: "CARD_ID --on CARD_ID...", summary: "remove a dependency",
    full: "CARD_ID --on CARD_ID... [--board ID|PATH] [--json]",
    options: [["--on CARD_ID", "the dependency to remove (repeatable)"], BOARD, JSON_OUT],
  },
  {
    name: "attach", group: "Cards", args: "CARD_ID FILE...", summary: "save files on a card, print markdown links",
    full: "CARD_ID FILE... [--board ID|PATH] [--json]",
    details: "Saves local files (screenshots, logs, recordings) as attachments of a card and prints a markdown line for each: ![name](/api/boards/…/attachments/ID) for images, [name](…) for other files. Paste those lines into a report to show images inline, since a /tmp path in a report is not durable.\nIt reads each FILE as you, so it can read what you can; the server never reads paths. Nothing is sent to any service outside Bakery.",
    options: [BOARD, JSON_OUT],
    examples: [["bakery-cli attach CARD_ID before.png after.png", ""]],
  },
  {
    name: "ready", group: "Runs", args: "CARD_ID", summary: "move a card to Ready",
    full: "CARD_ID [--board ID|PATH] [--yes]",
    details: "On a board with pickup on, Ready can start a paid Pi run at once, so it needs --yes there. A Triage card whose text asks for something only a person can do (a physical device, screenshots by hand, staging) or never says what done looks like is listed with its flags and needs --yes too.",
    options: [BOARD, ["--yes", "confirm on a pickup-enabled board, or move a flagged card anyway"]],
  },
  {
    name: "triage", group: "Runs", args: "CARD_ID", summary: "move a card back to Triage",
    full: "CARD_ID [--board ID|PATH]", options: [BOARD],
  },
  {
    name: "start", group: "Runs", args: "CARD_ID... --yes", summary: "run Pi on cards now",
    full: "CARD_ID... [--board ID|PATH] --yes",
    details: "Runs Pi on Ready, Review or Failed cards. A retry reuses the card's worktree and Pi session. Each card starts on its own, so one refusal does not stop the others.",
    options: [BOARD, ["--yes", "confirm the paid run"]],
  },
  {
    name: "recover", group: "Runs", args: "CARD_ID --yes", summary: "start a Failed card in a fresh Pi session",
    full: "CARD_ID [--board ID|PATH] --yes",
    details: "For a Failed card whose provider rejected its saved session history, which start refuses. The worktree, edits and review feedback carry over; the old session and log are kept.",
    options: [BOARD, ["--yes", "confirm the paid run"]],
  },
  {
    name: "running", group: "Runs", summary: "what agents are doing on every board, and what waits for you",
    full: "[--watch] [--json]",
    details: "Lists the runs, agent reviews, PR drafts and automatic PR openings going now (card, repository, kind, time so far, current tool), then the cards waiting for you, then how many will start without you. Sized for a terminal pane about 40 columns wide; --watch keeps it open, as the Herdr plugin does (docs/reference.md). In a short pane the counts stay at the top and j/k scroll the list.\nPiped, each item is one tab-separated line led by running, waiting or queued.",
    options: [["--watch", "redraw every 2 seconds until q (terminal only)"], ["--json", "print { active, waiting, queued }"]],
  },
  {
    name: "runs", group: "Runs", args: "CARD_ID", summary: "a card's attempts, tokens and cost",
    full: "CARD_ID [--board ID|PATH] [--json]",
    details: "Lists each attempt's tokens and cost (\"—\" when an older attempt has no record) and the card total, including agent reviews. --json prints { cardId, total, runs, reviews }.",
    options: [BOARD, JSON_OUT],
  },
  {
    name: "close", group: "Runs", args: "CARD_ID", summary: "move a Review card to Done without merging",
    full: "CARD_ID [--board ID|PATH] [--json]",
    details: "The worktree and branch stay. No command approves a merge.",
    options: [BOARD, JSON_OUT],
  },
  {
    name: "conflicts", group: "Runs", summary: "cards whose merge conflicts",
    full: "[--board ID|PATH] [--json]", options: [BOARD, JSON_OUT],
  },
  {
    name: "archive", group: "Tidy up", args: "CARD_ID...", summary: "archive Done cards",
    full: "CARD_ID... [--board ID|PATH] [--json]",
    details: "Accepts only Done cards, and archives all or none.",
    options: [BOARD, JSON_OUT],
  },
  {
    name: "restore", group: "Tidy up", args: "CARD_ID", summary: "move an archived card back to Done",
    full: "CARD_ID [--board ID|PATH] [--json]", options: [BOARD, JSON_OUT],
  },
  {
    name: "purge-attachments", group: "Tidy up", args: "CARD_ID... --yes", summary: "delete archived cards' files for good",
    full: "CARD_ID... --yes [--board ID|PATH] [--json]",
    details: "Permanently deletes the attached files and records of archived cards, all or none. It cannot be undone, even if the card is restored, so it needs --yes.",
    options: [["--yes", "confirm the deletion"], BOARD, JSON_OUT],
  },
  {
    name: "boards", group: "Boards", summary: "list boards",
    full: "[--json]", options: [JSON_OUT],
  },
  {
    name: "board-add", group: "Boards", args: "[PATH]", summary: "add a repository as a board",
    full: "[PATH] [--json]",
    details: "PATH defaults to the current directory. The server resolves it to its Git root and refuses a repository that already has a board.",
    options: [JSON_OUT],
  },
  {
    name: "board", group: "Boards", args: "[ID|PATH]", summary: "a board's integration and auto-review state",
    full: "[ID|PATH] [--integration local|github-pr] [--json]",
    details: "--integration github-pr makes a card Done when its GitHub pull request merges onto origin/main (needs gh and a GitHub remote); --integration local merges on Approve.",
    options: [["--integration MODE", "local or github-pr"], JSON_OUT],
  },
  {
    name: "pr", group: "Boards", args: "CARD_ID [URL|off]", summary: "link a card to a pull request",
    full: "CARD_ID [URL|off] [--board ID|PATH] [--json]",
    details: "Links a card to a pull request URL instead of the bakery/CARD_ID branch lookup; off removes the link. With no URL, prints the card's pull request.",
    options: [BOARD, JSON_OUT],
  },
  {
    name: "stats", group: "Boards", summary: "card counts per lane and the pickup state",
    full: "[--board ID|PATH] [--json]", options: [BOARD, JSON_OUT],
  },
  {
    name: "agents", group: "Boards", args: "[N|auto]", summary: "agents at once across all boards: show or set",
    full: "[N|auto] [--json]",
    details: "Card runs and agent reviews on every board share this many slots, since each ends with the repository's tests. auto is a quarter of the CPU cores, at least 2. Automatic work (pickup, send-backs, CI and hook fixes, sentinels, reviews) waits for a slot; a run you start yourself always starts.",
    options: [JSON_OUT],
    examples: [["bakery-cli agents 4", ""], ["bakery-cli agents auto", ""]],
  },
  {
    name: "limits", group: "Boards", args: "[on|off]", summary: "spend limits: show, or turn them on or off",
    full: "[on|off] [--board ID|PATH] [--json]",
    details: "Spend limits are the daily start limit, the daily cost budget and the agent reviewer's diff caps. They are off by default, and apply only when on; the stored values are kept either way. Concurrency and loop guards (send-back, CI-fix and retry caps) always apply. Set the values with pickup --limit and --budget.",
    options: [BOARD, JSON_OUT],
    examples: [["bakery-cli limits on", ""], ["bakery-cli limits off --board ~/code/scratch", ""]],
  },
  {
    name: "pickup", group: "Boards", args: "[on|off|reset]", summary: "automatic starts: show or change them",
    full: "[on|off|reset] [--concurrency 1-4] [--limit 0-99|off] [--budget USD|off] [--board ID|PATH] [--yes]",
    details: "With no argument, prints the pickup state. on, and reset (which clears the 24-hour count), can start paid Pi runs, so they need --yes. --limit and --budget are stored, and apply only while the board's limits are on (see limits).",
    options: [["--concurrency N", "runs at once, 1 to 4"], ["--limit N|off", "most automatic starts per rolling 24 hours; 0 or off means no limit"], ["--budget USD|off", "stop starting once 24 hours of runs cost this much"], BOARD, ["--yes", "confirm"]],
    examples: [["bakery-cli pickup on --concurrency 2 --budget 20 --yes", ""], ["bakery-cli pickup off", ""]],
  },
  {
    name: "sentinels", group: "Sentinels", summary: "list monitors: state, schedule, latest run",
    full: "[--board ID|PATH] [--json]",
    details: "Sentinels are persistent monitors that are not cards. Pausing or finishing a job card never changes a sentinel.",
    options: [BOARD, JSON_OUT],
  },
  {
    name: "sentinel-pause", group: "Sentinels", args: "SENTINEL_ID", summary: "stop its future runs",
    full: "SENTINEL_ID [--board ID|PATH] [--json]", details: "Also holds its unstarted jobs.", options: [BOARD, JSON_OUT],
  },
  {
    name: "sentinel-resume", group: "Sentinels", args: "SENTINEL_ID", summary: "let it run again, at once",
    full: "SENTINEL_ID [--board ID|PATH] [--json]", options: [BOARD, JSON_OUT],
  },
  {
    name: "sentinel-run", group: "Sentinels", args: "SENTINEL_ID", summary: "run an enabled sentinel now",
    full: "SENTINEL_ID [--board ID|PATH] [--json]", options: [BOARD, JSON_OUT],
  },
  {
    name: "service", group: "Setup", args: "ACTION", summary: "run Bakery in the background: install, restart, logs",
    full: "install|uninstall|start|stop|restart|status|logs [--host HOST] [--yes]",
    details: "install runs this checkout as a systemd user service (Linux) or launchd agent (macOS) that starts at login, restarts on failure and checks for updates every 2 minutes. Settings go in ~/.config/bakery/bakery.env, which install creates once and never overwrites. restart waits for active runs to finish first. stop and uninstall end active runs at once, so they need --yes. Run install again after moving node, npm or pi.",
    options: [["--host HOST", "the bind address written to a new bakery.env (default: 127.0.0.1)"], ["--yes", "confirm stop or uninstall"]],
    examples: [["bakery-cli service install", ""], ["bakery-cli service install --host 100.64.0.10", "listen on a tailnet address"], ["bakery-cli service restart", "after editing bakery.env"]],
  },
  {
    name: "doctor", group: "Setup", summary: "check tools, data, server and boards",
    full: "[--json]",
    details: "Checks Node, git, pi, gh, worktrunk, the data directory, the server and each board, printing PASS, WARN or FAIL per check; it exits 1 if any check fails. Against a remote BAKERY_URL it checks only the server and boards.",
    options: [JSON_OUT],
  },
  {
    name: "help", group: "Setup", args: "[COMMAND]", summary: "this overview, or one command's options",
    full: "[COMMAND]",
  },
];

export const ENV = [
  ["BAKERY_URL", "the server, e.g. 127.0.0.1:4317; the scheme and port 4317 may be left out"],
  ["BAKERY_PORT", "the local server's port (default: 4317)"],
  ["BAKERY_ALLOW_REMOTE=1", "allow a BAKERY_URL that is not this machine"],
  ["NO_COLOR", "plain text on a terminal"],
];

const signature = cmd => `${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;

export function overview(version) {
  const width = Math.max(...COMMANDS.map(cmd => signature(cmd).length)) + 2;
  const out = [];
  if (pretty()) out.push("", banner(version), "");
  out.push(`${c.head("Usage")}  bakery-cli ${c.cmd("<command>")} ${c.arg("[options]")}`);
  for (const group of GROUPS) {
    out.push("", c.head(group));
    for (const cmd of COMMANDS.filter(item => item.group === group)) {
      const sig = signature(cmd);
      const [first, ...more] = wrap(cmd.summary, Math.max(30, columns() - width - 2));
      out.push(`  ${c.cmd(cmd.name)}${c.arg(pad(sig.slice(cmd.name.length), width - cmd.name.length))}${first}`);
      for (const line of more) out.push(" ".repeat(width + 2) + line);
    }
  }
  const table = rows => {
    const w = Math.max(...rows.map(row => row[0].length)) + 2;
    return rows.flatMap(([a, b]) => wrap(b, Math.max(30, columns() - w - 2)).map((line, i) => i ? " ".repeat(w + 2) + line : `  ${c.arg(pad(a, w))}${line}`));
  };
  out.push(
    "", c.head("Options"),
    ...table([["--board ID|PATH", "pick the board (default: the one for the current directory, or the only one)"], ["--json", "print the full API data"], ["--yes", "confirm a paid run or a deletion"], ["-v, --version", "print the version"]]),
    "", c.head("Environment"), ...table(ENV),
    "", `  bakery-cli help <command> for its options and examples. Installed with npm link, it is also bakery.`,
  );
  return out.join("\n");
}

export function commandHelp(name) {
  const cmd = COMMANDS.find(item => item.name === name);
  if (!cmd) return undefined;
  const out = [`${c.cmd(`bakery-cli ${cmd.name}`)}  ${cmd.summary}`, "", c.head("Usage"), `  bakery-cli ${cmd.name}${cmd.full ? ` ${c.arg(cmd.full)}` : ""}`];
  if (cmd.details) out.push("", ...cmd.details.split("\n").flatMap((para, i) => [...(i ? [""] : []), ...wrap(para, Math.min(columns(), 100) - 4).map(line => `  ${line}`)]));
  if (cmd.options?.length) {
    const w = Math.max(...cmd.options.map(row => row[0].length)) + 2;
    out.push("", c.head("Options"), ...cmd.options.map(([flag, what]) => `  ${c.arg(pad(flag, w))}${what}`));
  }
  if (cmd.examples?.length) {
    const w = Math.max(...cmd.examples.map(row => row[0].length)) + 3;
    out.push("", c.head("Examples"), ...cmd.examples.map(([ex, what]) => `  ${c.dim("$")} ${what ? pad(ex, w) + c.dim(`# ${what}`) : ex}`));
  }
  return out.join("\n");
}

/** The usage line for one command, for argument errors. */
export const usageLine = name => {
  const cmd = COMMANDS.find(item => item.name === name);
  return cmd ? `Usage: bakery-cli ${cmd.name}${cmd.full ? ` ${cmd.full}` : ""}` : "";
};

// The closest command name, for a typo.
export function suggest(name) {
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const best = COMMANDS.map(cmd => ({ name: cmd.name, d: distance(name, cmd.name) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(name.length / 3)) ? best.name : undefined;
}
