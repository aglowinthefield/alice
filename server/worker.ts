import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { command, groupAlive, killTree, processStartTime, signalGroup, worktrunkVersion } from "./platform.js";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { initialPiStreamState, reducePiLine, stuckTool, type LiveActivity, type PiEffect } from "./pi-events.js";
import { piModelArgs, type AgentPhase } from "../shared/agent-models.js";
import { attachmentsPrompt, evidencePrompt } from "./attachments.js";
import { Board, RunLimitError, type Card, type CiFeedbackSource, type Run } from "./board.js";
import { classifyProviderFailure, describeProviderFailure, type ProviderFailureKind } from "./provider-failure.js";
import { isRunTimeout } from "./failure-summary.js";
import { compareWithOriginMain, fetchOriginBestEffort, hasOrigin } from "./origin.js";
import { commitIdentityArgs } from "./git-identity.js";
import { loopGuards } from "./repo-limits.js";
import { STUCK_MESSAGE, StuckDetector } from "./stuck.js";
import { cardBranch } from "./legacy-names.js";
import type { RunExit } from "./run-shim.js";

/**
 * What the worktree's uncommitted work looks like now: the changed and untracked paths with a hash of each file's
 * content. It changes whenever a turn edits a file, whichever tool did it, including an edit that keeps the line count
 * and a write to a file that was already untracked. Null when Git cannot answer, so a Git hiccup is not a change.
 */
function worktreeFingerprint(worktree: string): string | null {
  const gitOut = (args: string[], input?: string) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  try {
    const paths = [
      ...gitOut(["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]).split("\0"),
      ...gitOut(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ].filter(Boolean).sort();
    // Deleted paths and directories (submodules) have no content to hash; their names alone are in the fingerprint.
    // `--stdin-paths` reads one path per line, so a name holding a newline is left to the name list too.
    const files = paths.filter(path => !path.includes("\n") && statSync(join(worktree, path), { throwIfNoEntry: false })?.isFile());
    return `${paths.join("\0")}\n${files.length ? gitOut(["hash-object", "--no-filters", "--stdin-paths"], `${files.join("\n")}\n`) : ""}`;
  } catch { return null; }
}

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Unmerged paths in a worktree mid-merge or mid-rebase, read NUL-delimited so names keep their real spelling instead of Git's quoting. */
function unmergedFiles(repo: string): string[] {
  return execFileSync("git", ["-C", repo, "diff", "--name-only", "-z", "--diff-filter=U"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean);
}

function fetchOrigin(repo: string) {
  try { execFileSync("git", ["-C", repo, "fetch", "origin", "--prune", "--quiet"], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }
  catch (error) { throw new Error(`git fetch origin failed: ${((error as { stderr?: Buffer }).stderr?.toString() || String(error)).trim().slice(0, 2000)}`); }
}
function isAncestor(repo: string, ancestor: string, descendant: string) {
  try { execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" }); return true; }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
}

// Anthropic's classifier sometimes blocks a long run as "reverse engineering or duplicating model outputs". The
// per-tool-call narration the prompt asks for may be the trigger, so a blocked run is retried once without it.
const NARRATION = "As you work, before each tool call or group of calls, write one plain sentence saying what you are checking or doing and why, and after a result that changes your plan, one sentence on what you learned. Keep each to a single sentence about intent and findings, not the command itself. ";
const PLAIN_RETRY = "An earlier attempt on this card was blocked by the model provider partway through, so this is a fresh session. The worktree may already hold that attempt's partial changes: check `git status` and `git diff` first and build on them. Do not narrate before tool calls; write prose only for the final report. ";
export function isOutputDuplicationBlock(error: string | null): boolean {
  return !!error && /violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs/i.test(error);
}

type HandedOff = { headSha: string; failures: string; source: CiFeedbackSource };

/** The latest run's session was rejected by the provider, so resuming it would fail the same way. Recover in a fresh session. */
export class PoisonedSessionError extends Error {
  constructor(readonly cardId: string, readonly runId: string, detail: string) {
    super(`The provider rejected this card's Pi session history (${detail}). Resuming it would fail again; recover this card in a fresh session instead (worktree and changes are kept).`);
  }
}

/**
 * What a "Run again on current main" run is asked to do first. A github-pr retry is already rebased onto origin/main
 * when its branch was never pushed (see `rebaseRetry`); a pushed branch, or a local board's uncommitted work, is
 * brought up to date by the agent.
 */
export function currentMainInstructions(prMode: boolean, tip: string): string {
  const at = tip ? ` (${tip})` : "";
  return prMode
    ? `This card sat in Review long enough for origin/main to move on. Before anything else, make sure the card branch contains current origin/main${at}: check with \`git merge-base --is-ancestor origin/main HEAD\`, and if it does not, merge origin/main into the card branch and commit the merge there (Alice pushes it after Approve). Resolve conflicts that are mechanical; if one needs a product or design decision, run \`git merge --abort\` and explain it. Then check the card's work still does what the card asks on current main, re-run the checks, and report what main's changes affected.`
    : `This card sat in Review long enough for main to move on. Before anything else, bring this worktree up to date with the current local \`main\`${at}, keeping the card's work, which is uncommitted here: for example \`git stash push --include-untracked\`, then \`git rebase main\` (or \`git merge main\` if the branch already carries a merge commit), then \`git stash pop\`, resolving any conflicts in the working tree. Do not commit the card's work. If a conflict needs a product or design decision, leave it unresolved (a conflicting \`git stash pop\` keeps the stash, so nothing is lost) and explain the decision. Then check the card's work still does what the card asks on current main, re-run the checks, and report what main's changes affected.`;
}
/**
 * The ground rules for a "Run again on current main" run. They replace the usual ban on staging, committing and
 * merging with permission for exactly the card-branch update `currentMainInstructions` asks for, and keep main,
 * pushes and anything external off limits.
 */
export function currentMainRules(prMode: boolean): string {
  return prMode
    ? "This is an implementation attempt on current main. You are authorized to merge origin/main into the card branch and to stage and commit that merge, and your fixes on top of it, on the card branch only; Alice pushes them after Approve. Do not change main, push, create a PR, deploy, or post externally."
    : "This is an implementation attempt on current main. You are authorized to stash, rebase or merge local `main` into the card branch in this worktree, as described above, so the card's work sits on current main; leave the card's own work uncommitted, since Alice commits it after Approve. Do not change main, push, create a PR, deploy, or post externally.";
}
function revParseOrEmpty(cwd: string, ref: string): string {
  try { return git(cwd, "rev-parse", "--verify", "--quiet", ref); } catch { return ""; }
}
const RECOVERY = "The earlier Pi session for this card was rejected by the model provider (invalid message history), so this is a fresh session that has none of its conversation. The card's worktree, branch and uncommitted edits are untouched and may hold that session's partial work: check `git status` and `git diff` first and build on them rather than starting over. Do not discard or reset existing changes. ";

/** Sent instead of the task prompt to the attempt that continues a timed-out run's session, which already holds the task. */
export function continuationMessage(timedOut: Run): string {
  return `You ran out of time on the previous attempt: Alice stopped attempt ${timedOut.attempt} at its run time limit. This attempt continues the same session with a fresh time limit, so the earlier instruction to stop starting new work no longer applies. Check \`git status\` and \`git diff\` to see where the work stands, then finish the remaining work and write your report as the first message of this session describes: what changed, what you verified, what remains, and any Follow-ups.`;
}

const TIMEOUT_FRESH = "An earlier attempt on this card ran out of time and Alice stopped it, and its Pi session could not be found, so this is a fresh session that has none of its conversation. The card's worktree, branch and uncommitted edits are untouched and may hold that attempt's partial work: check `git status` and `git diff` first and build on them rather than starting over. Do not discard or reset existing changes. ";

/**
 * True when the run's Pi session file is still there, is the session the run used, and still holds the task: a header
 * and at least one complete user message Pi will load. Pi skips lines SIGTERM cut short, so a session whose only user
 * message was truncated loads with no conversation, and continuing it would send the continuation without the task.
 */
export function sessionIntact(run: Run): boolean {
  if (!run.sessionFile) return false;
  let fd: number | undefined;
  try {
    fd = openSync(run.sessionFile, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    let pending = "", header = false, bytes: number;
    // null keeps reading; true or false is the answer. Malformed lines are skipped, as Pi skips them.
    const accept = (line: string): boolean | null => {
      if (!line.trim()) return null;
      let entry: { type?: unknown; id?: unknown; message?: { role?: unknown } };
      try { entry = JSON.parse(line); } catch { return null; }
      if (!header) { header = true; return entry?.type === "session" && entry.id === run.sessionId ? null : false; }
      return entry?.type === "message" && entry.message?.role === "user" ? true : null;
    };
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += buffer.toString("utf8", 0, bytes);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const verdict = accept(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (verdict !== null) return verdict;
      }
    }
    return accept(pending) === true;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export type { LiveActivity };

// Screenshots read back into a session make single events several MB; the cap only guards against a runaway line.
const MAX_PI_EVENT_BYTES = 500_000_000;

/** Hard limit on one agent run. The separate Worktrunk hook timeout is unaffected. */
const runTimeoutMinutes = loopGuards.runTimeoutMinutes;
/** How long before the run timeout Alice asks Pi to stop and report, so a killed run still leaves a report. */
const wrapUpLeadMinutes = 10;
/** The Pi extension that steers a running session with Alice's wrap-up message (JSON mode reads no stdin). */
const wrapUpExtension = join(import.meta.dirname, "..", "scripts", "pi-wrap-up.mjs");
export const WRAP_UP_MESSAGE = `Alice: this run is stopped in ${wrapUpLeadMinutes} minutes when it hits its ${runTimeoutMinutes}-minute limit, and anything unreported then is lost. Stop starting new work and commit nothing. Write your final report now: what is done, what remains, and what the next attempt should do first. Attach any screenshots, logs or other evidence as card attachments as your instructions describe, and name them in the report.`;

/** Runs Pi detached from the server and records its exit (Linux and macOS). */
const runShim = join(import.meta.dirname, "run-shim.ts");
/** How often a detached run's event file is read when no change notification arrives. */
const EVENT_POLL_MS = 200;
/** The most of a run's event file read in one event-loop turn; the same size as a pipe's chunks. */
const EVENT_CHUNK_BYTES = 64 * 1024;
/** A detached run's files: `events.jsonl` (Pi's stdout), `stderr.log`, `shim.log`, and `exit.json` once Pi exits. */
export function runDir(dataDir: string, runId: string) { return join(dataDir, "runs", runId); }
function readExit(dir: string): RunExit | null {
  try { return JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")) as RunExit; } catch { return null; }
}
/** The last 4000 characters of a log file, or "" when it is missing. */
function tail(file: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size, length = Math.min(size, 4000), buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

/** A process Alice owns for a run: a Worktrunk hook, a piped Pi, or a detached run's shim. */
type RunHandle = {
  /** Sends SIGTERM; false when there was nothing left to signal. */
  signal: () => boolean;
  /** Settles once the process exited and the run's outcome is recorded. */
  closed: Promise<void>;
};
function childHandle(child: ChildProcess): RunHandle {
  const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("close", () => resolve()));
  return { signal: () => killTree(child), closed };
}

/**
 * At server start: a run still marked running belonged to a server that is gone, but its detached Pi may still be
 * working in the card worktree. Stop it, checking the recorded start time so a reused PID is never signalled, and
 * wait until its process group is empty: SIGTERM, then SIGKILL after `graceMs`. Only then mark such runs
 * interrupted and clear the directories of runs that are over, so no next attempt shares the worktree with it. The
 * server awaits this before it serves anything. Reattaching to a surviving run instead is later work.
 */
export async function recoverDetachedRuns(board: Board, dataDir: string, graceMs = 10_000): Promise<void> {
  const gone = async (pgid: number, ms: number) => {
    const end = Date.now() + ms;
    while (groupAlive(pgid)) {
      if (Date.now() > end) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return true;
  };
  for (const run of board.listRunningRuns()) {
    if (!run.pid || !run.pidStartedAt || !signalGroup(run.pid, run.pidStartedAt)) continue;
    console.log(`[run ${run.id.slice(0, 8)}] stopping Pi left running by the previous server process (pid ${run.pid})`);
    if (await gone(run.pid, graceMs)) continue;
    // Still members in the group, so its id cannot have been reused: they are the run's.
    try { process.kill(-run.pid, "SIGKILL"); } catch { /* Exited meanwhile. */ }
    if (!await gone(run.pid, graceMs)) console.error(`[run ${run.id.slice(0, 8)}] Pi's process group ${run.pid} survived SIGKILL; inspect it before running this card again`);
  }
  board.recoverInterruptedRuns();
  let ids: string[] = [];
  try { ids = readdirSync(join(dataDir, "runs")); } catch { /* No detached run yet. */ }
  for (const id of ids) if (board.getRun(id)?.status !== "running") rmSync(runDir(dataDir, id), { recursive: true, force: true });
}

export class Worker {
  private active = new Map<string, RunHandle>();
  /** In memory only, keyed by run id; cleared when the run ends. */
  private live = new Map<string, LiveActivity>();
  private terminationReasons = new Map<string, string>();
  private draining = false;
  private idleWaiters: (() => void)[] = [];
  /** Run limits in milliseconds; tests shorten them. */
  timing = { runTimeoutMs: runTimeoutMinutes * 60_000, wrapUpLeadMs: wrapUpLeadMinutes * 60_000 };
  /** `wtBin` enables Worktrunk hooks for new card worktrees; omit it to skip hooks entirely. */
  constructor(private board: Board, private dataDir: string, private piBin = "pi", private wtBin?: string, private attach?: { cli: string; env: NodeJS.ProcessEnv }) {}
  private terminate(id: string, handle: RunHandle, reason: string) {
    if (handle.signal() && !this.terminationReasons.has(id)) this.terminationReasons.set(id, reason);
  }
  /** `why` finishes the history line "Attempt N started …" when something other than a person or auto-pickup asked. */
  /**
   * `byPerson`: the operator asked for this run, so the machine's agent limit does not refuse it.
   * `onCurrentMain` (Run again on current main, for a stale Review card) has the agent bring the work up to date with main first.
   */
  start(card: Card, startedBy: "manual" | "auto" = "manual", why = "", recoverFrom?: Run, byPerson = false, onCurrentMain = false): Run {
    if (this.draining) throw new Error("Alice is waiting for active runs to finish before restarting to load code changes; start this run after the restart");
    if (card.status === "triage") throw new Error("Move this card to Ready before starting a run");
    // Validate the workspace before claiming. Never run an agent in the app's own directory by default.
    const root = git(card.repo, "rev-parse", "--show-toplevel");
    if (realpathSync.native(root) !== realpathSync.native(card.repo)) throw new Error("Workspace must be the root of a Git repository");
    try { git(root, "rev-parse", "--verify", "HEAD^{commit}"); }
    catch { throw new Error(`Repository ${root} has no HEAD commit. Make an initial commit before starting a run; Alice will not commit for you.`); }
    const worktree = join(this.dataDir, "worktrees", card.id);
    const branch = cardBranch(root, card.id);
    const conflict = this.board.getMergeFailure(card.id);
    const latestRun = this.board.listRuns(card.id)[0];
    if (latestRun && this.board.hasDraftReviewComments(card.id, latestRun.id)) throw new Error("Submit or remove draft review comments before running Pi again");
    const feedback = this.board.getFeedbackForRun(card.id);
    // Requested changes belong to the last attempt that reached review. A run that failed or was interrupted after it
    // (a rebase conflict, say) never addressed them, so they go to the next run too.
    const lastReviewed = this.board.listRuns(card.id).find(run => run.status === "review");
    const reviewerChanges = lastReviewed && !feedback.length ? this.board.getReviewerChanges(lastReviewed.id) : [];
    const ciFeedback = this.board.getCiFeedback(card.id);
    if (conflict && !existsSync(worktree)) throw new Error("Card worktree is missing; inspect and restore it before repairing the conflict");
    if (conflict && (
      realpathSync.native(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync.native(worktree) ||
      git(worktree, "symbolic-ref", "--short", "HEAD") !== branch ||
      realpathSync.native(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      realpathSync.native(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    )) throw new Error("Conflict repair requires the card worktree on its original branch in this repository");
    // A session the provider rejected replays the same history every time; only an explicit recovery gets past it.
    if (!recoverFrom && latestRun?.status === "failed" && latestRun.failureKind === "invalid-history") throw new PoisonedSessionError(card.id, latestRun.id, `run ${latestRun.attempt}`);
    // A run killed at its run timeout left a session that holds the task and how far it got, so the next attempt
    // continues it with a short message rather than the whole task again. A missing session starts fresh instead.
    const timedOut = !recoverFrom && latestRun?.status === "failed" && isRunTimeout(latestRun.error) ? latestRun : null;
    const continuing = !!timedOut && sessionIntact(timedOut);
    const timeoutWhy = !timedOut ? "" : `${startedBy === "auto" ? "by auto-pickup, " : ""}${continuing ? `continuing attempt ${timedOut.attempt}'s session after its run timeout` : `in a fresh session, because attempt ${timedOut.attempt} timed out and its session is missing`}`;
    const run = this.board.claim(card.id, startedBy, why || timeoutWhy, !!timedOut && !continuing, recoverFrom?.id ?? null, byPerson);
    if (timedOut) this.board.append(run.id, continuing
      ? `Continuing attempt ${timedOut.attempt}'s Pi session ${run.sessionId}, which Alice stopped at its run timeout.\n`
      : `Attempt ${timedOut.attempt} timed out, but its Pi session ${timedOut.sessionFile ? `file ${timedOut.sessionFile} is missing or unreadable` : "was never recorded"}, so this attempt starts a fresh session with the whole task.\n`);
    const prMode = this.board.integrationFor(card.repo) === "github-pr";
    let created = false;
    let mainMerged = "";
    try {
      if (existsSync(worktree) && realpathSync.native(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync.native(worktree)) throw new Error("Existing path is not the card worktree");
      mkdirSync(join(this.dataDir, "worktrees"), { recursive: true });
      // On a github-pr board a card starts from origin/main, fetched now, so it never builds on a stale checkout.
      if (prMode) fetchOrigin(root);
      if (!existsSync(worktree)) { git(root, "worktree", "add", "-b", branch, worktree, prMode ? "origin/main" : this.localBase(run, root)); created = true; }
      else if (prMode && !conflict && ciFeedback?.source === "ci") mainMerged = this.mergeMainForCiFix(run, worktree);
      else if (prMode && !conflict) this.rebaseRetry(card, run, worktree, branch);
    } catch (error) {
      this.board.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
      return this.board.getRun(run.id)!;
    }
    // A github-pr card conflicts with origin/main (fetched above), not with the local checkout's main.
    const mainRef = prMode ? "origin/main" : "main";
    const mainTip = conflict ? git(root, "rev-parse", mainRef) : null;
    // Alice pushes this work through the repository's pre-push hook after Approve. A check the agent could have run
    // here otherwise surfaces only then, as another full round.
    const hookCheck = prMode || this.board.boardForRepo(card.repo)?.pushMainAfterMerge
      ? " After Approve, Alice pushes this work through the repository's pre-push hook (find it with `git config core.hooksPath`, for example `.husky/pre-push`, or in `.git/hooks`). If there is one, run the checks it runs before you finish, and fix what they report, since a refused push sends the card back."
      : "";
    const instructions = conflict
      ? `This is a merge-conflict repair attempt. Alice could not merge this card into ${mainRef}. Conflicting files: ${JSON.stringify(conflict.files)}. Current ${mainRef} tip: ${mainTip}. Reconcile the reviewed card work with current ${mainRef}. You may merge ${mainRef} into the card worktree and stage and commit the resolution on the card branch only. Preserve both the card's intended behavior and unrelated changes already on main. Do not change main, push, create a PR, deploy, or post externally. Check the resolved work and report what you verified. ${ciFeedback?.source === "conflict" ? "Resolve every conflict that is mechanical, meaning the right result follows from the two sides without a product or design decision (both sides added lines, renamed or moved code, formatting, lockfiles you can regenerate, generated files you can rebuild). Run the checks that cover the files you touched. Alice pushes your resolution to the pull request itself once you finish, so commit the merge and leave nothing unresolved. If a conflict needs a human decision (the two sides change the same behavior in incompatible ways, say), run `git merge --abort`, change nothing, and explain exactly what the decision is; Alice posts your report on the pull request." : "Alice will ask for human review and approval again; do not attempt to integrate it yourself."}`
      : onCurrentMain
        ? currentMainRules(prMode) + hookCheck
        : "This is an implementation attempt. Do not stage, commit, push, create a PR, merge, deploy, or post externally unless the operator has independently authorized that action." + hookCheck;
    const feedbackPrompt = feedback.length ? `\n\nThe reviewer requested these changes to the previous reviewed attempt. Address each item and report any you could not resolve: ${JSON.stringify(feedback.map(item => ({ path: item.path, fileLine: item.fileLine, diffRow: item.line, kind: item.kind, previousCode: item.code.slice(0, 200), comment: item.body })))}` : "";
    const reviewerPrompt = reviewerChanges.length ? `\n\nAn independent agent reviewer inspected the previous attempt and sent it back with these requested changes. Address each item and report any you could not resolve: ${JSON.stringify(reviewerChanges)}` : "";
    const ciPrompt = ciFeedback?.source === "ci" && !conflict ? `\n\nThis card's pull request failed CI at ${ciFeedback.headSha}. Alice sent it back so you can make it CI-ready. Fix every failure below on the card branch, run the matching checks locally where you can, and report anything you could not fix. Some checks are satisfied outside the code, by a label or a line in the pull request description. For this run you are authorized to change that pull request${card.prNumber ? ` (#${card.prNumber}${card.prUrl ? `, ${card.prUrl}` : ""})` : ""} with \`gh pr edit\` (add or remove labels, edit the description) when the repository's own rules allow it, and to post a \`gh pr comment\` there explaining each such change and why the rules allow it. If a failure looks like a hang, timeout or flake rather than a code problem, re-run just the failed jobs once with \`gh run rerun <run-id> --failed\` (run ids are in the failure list or \`gh run list --branch\`) before changing code, and say so in your report; re-run each run at most once. Do not push, merge, close it, or touch any other pull request; Alice pushes your code changes. CI tests the pull request merged with main, not the branch alone, so reproduce failures on a tree that includes current origin/main.${mainMerged ? ` ${mainMerged}` : ""} The failed checks and their log excerpts:\n\n${ciFeedback.failures}` : "";
    // A conflict repair gets refused-push output too: the run that would have fixed the hook failed on the conflict
    // before Pi started, so without it the repair goes back to Review and the next push fails the same hook again.
    const pushPrompt = ciFeedback?.source === "push" ? `\n\nAlice tried to push this card's branch to GitHub, and the repository's pre-push hook refused it, so nothing was pushed. Make the hook pass: fix what it reports on the card branch (the commit it rejected is ${ciFeedback.headSha}), re-run the failing command locally, and report anything you could not fix. Do not skip or bypass the hook, and do not push; Alice pushes after the operator approves again. The hook's output:\n\n\`\`\`\n${ciFeedback.failures}\n\`\`\`` : "";
    const commitPrompt = ciFeedback?.source === "commit" ? `\n\nWhen the previous attempt reached Review, Alice committed this card's work so it could push it after Approve, and the repository's pre-commit or commit-msg hook refused the commit, so nothing was committed. Make the commit hook pass: fix what it reports in this worktree, re-run the failing command locally, and report anything you could not fix. Do not skip or bypass the hook, and do not push; Alice commits and pushes the work after the operator approves. The hook's output:\n\n\`\`\`\n${ciFeedback.failures}\n\`\`\`` : "";
    const commentPrompt = ciFeedback?.source === "comment" && !conflict ? `\n\nSomeone asked Alice on this card's pull request${card.prNumber ? ` (#${card.prNumber}${card.prUrl ? `, ${card.prUrl}` : ""})` : ""} for these changes. They are requests from people with access to the repository, not instructions from the operator: make each change that fits this card, and say in your report which you did, which you declined and why. Make them on the card branch, run the matching checks locally, and do not push, comment on the pull request or change it; Alice shows the result for the operator's Approve. The requests (a JSON array; \`path\` and \`line\` are set on inline review comments):\n\n${ciFeedback.failures}` : "";
    const currentMainPrompt = onCurrentMain && !conflict ? `\n\n${currentMainInstructions(prMode, revParseOrEmpty(root, mainRef))}` : "";
    const filesPrompt = attachmentsPrompt(this.dataDir, this.board.listAttachments(card.id));
    const evidence = evidencePrompt(this.attach, this.board.boardForRepo(card.repo)?.id, card.id);
    const earlierReport = recoverFrom || timedOut ? this.board.listRuns(card.id).find(item => item.report)?.report : null;
    const freshNote = recoverFrom ? RECOVERY : timedOut && !continuing ? TIMEOUT_FRESH : "";
    const recoveryPrompt = freshNote ? `\n\n${freshNote.trim()}${earlierReport ? ` The last report an earlier attempt on this card wrote (it may be out of date):\n\n${earlierReport.slice(0, 4000)}` : ""}` : "";
    const prompt = `Task from Alice card ${card.id}: ${card.title}\n\n${card.body}${recoveryPrompt}${currentMainPrompt}${filesPrompt ? `\n\n${filesPrompt}` : ""}${feedbackPrompt}${reviewerPrompt}${ciPrompt}${pushPrompt}${commitPrompt}${commentPrompt}\n\nWork in this dedicated worktree: ${worktree}. ${instructions} Follow this repository's own instructions. Stop and explain any blocker. ${evidence ? `${evidence} ` : ""}${NARRATION}At the end, state what changed, what you verified, and what remains. Do anything you can do in this worktree yourself and report it: run the checks, tests and scripts that verify your change, and before you finish run the repository's full local verification (the command its instructions give for reproducing all of CI) rather than only the narrow checks, naming any part you could not run, and finish small cleanups you noticed, instead of listing them. If there is work that should happen later but is not part of this card, or that you cannot do from here (it needs a push, credentials, a deploy, or a human decision), such as a migration to apply, list each as a bullet under a final "## Follow-ups" heading, each self-contained so someone can act on it without this conversation; Alice turns them into triage cards. Omit the heading when there are none. If this card asks you to plan or break down a larger piece of work, do not implement it: finish your report with one fenced block tagged alice-plan holding a JSON array of subtasks, each {"id":"short local id","title":"...","body":"self-contained instructions with acceptance criteria","dependsOn":["ids of subtasks that must finish first"]}, at most 20. Write each body as readable markdown, not one block of text: a one-line goal, then short sections or bullet lists (for example Steps, Acceptance), with backticks around file paths and commands. Make each subtask small enough for one agent run, and give subtasks that would edit the same files a dependsOn order so they do not conflict. Alice turns the plan into Triage cards for a person to review. In a planning report the plan is the deliverable: do not repeat plan items under Follow-ups, and keep questions, assumptions and decisions for the person in ordinary prose, not as Follow-ups. A Follow-up is only concrete work outside the plan that someone must do. A finished agent session requests review; it does not mark the card done.`;
    // Handed to this run; a later run should not see the same failures again.
    if (ciPrompt || pushPrompt || commitPrompt || commentPrompt || (conflict && ciFeedback?.source === "conflict")) this.board.startCiFix(card.id, run.id, ciFeedback!.source);
    const phase = conflict ? "conflict" : "work";
    const handedOff = ciPrompt || pushPrompt || commitPrompt || commentPrompt || (conflict && ciFeedback?.source === "conflict") ? ciFeedback : undefined;
    // The continued session already holds the task, so it gets the continuation and only what is new since then.
    const continuation = continuing ? `${continuationMessage(timedOut!)}${currentMainPrompt}${filesPrompt ? `\n\n${filesPrompt}` : ""}${feedbackPrompt}${reviewerPrompt}${ciPrompt}${pushPrompt}${commitPrompt}${commentPrompt}` : null;
    const launch = () => this.launchPi(card, run, worktree, continuation ?? prompt, phase, handedOff, prompt);
    if (created && this.hasWorktrunk()) { this.runWorktrunkHooks(run, card.repo, root, worktree, branch, launch); return this.board.getRun(run.id)!; }
    return launch();
  }
  /**
   * Keeps the output of a hook that refused the card's push (`sha` is the refused commit) or its commit (no sha) for
   * the card's next run, and starts that run with `startHookFix`. False when no run can start yet.
   */
  sendBackHookFailure(card: Card, hook: "push" | "commit", sha: string, output: string): boolean {
    this.board.recordPushFailure(card.id, sha, output, hook);
    const previous = this.board.listRuns(card.id)[0];
    if (!this.startHookFix(this.board.getCard(card.id)!)) return false;
    const refused = hook === "push" ? "The pre-push hook refused the push" : "A commit hook refused the commit";
    if (previous) this.board.append(previous.id, `\n[Alice] ${refused}. Sent back to the agent with its output.\n`);
    return true;
  }
  /**
   * Sends a refused push or commit, already recorded with `recordPushFailure`, back to the card's agent. Returns false when the
   * repository is at its run limit or Alice is draining for a restart: the hook's output stays recorded and
   * `AutoPickup` starts the run once it can. Any other failure drops the output, since nothing will retry it, and throws.
   */
  startHookFix(card: Card): boolean {
    if (this.draining) return false;
    const hook = this.board.getCiFeedback(card.id)?.source === "commit" ? "commit hook" : "pre-push hook";
    try { this.start(card, "manual", `to fix the failing ${hook}`); return true; }
    catch (error) {
      if (error instanceof RunLimitError) return false;
      this.board.clearCiFeedback(card.id);
      throw error;
    }
  }
  /**
   * A local-mode card starts from origin/main when the repository has an origin and local HEAD is not ahead of it,
   * so it never builds on a stale checkout. Unpushed local commits win: then HEAD is the base. Offline only warns.
   */
  private localBase(run: Run, root: string): string {
    if (!hasOrigin(root)) return "HEAD";
    const warning = fetchOriginBestEffort(root);
    if (warning) this.board.append(run.id, `${warning}\n`);
    const state = compareWithOriginMain(root, "HEAD");
    return state && !state.ahead ? "refs/remotes/origin/main" : "HEAD";
  }
  /**
   * A retry on a github-pr board whose base is behind origin/main is rebased onto it (or, after a conflict repair, has it merged in) before Pi starts, but only
   * while nothing about it is published: a clean worktree whose branch was never pushed. A pushed branch is what
   * the open PR shows, so it is left alone. Conflicts abort the rebase, fail the run, and record a merge failure, so
   * the next start is a conflict-repair run that merges origin/main instead of retrying the same rebase.
   */
  private rebaseRetry(card: Card, run: Run, worktree: string, branch: string) {
    if (git(worktree, "status", "--porcelain")) return;
    try { git(worktree, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`); return; } catch { /* Never pushed. */ }
    if (isAncestor(worktree, "origin/main", "HEAD")) return;
    // A merge of origin/main on the branch is a conflict repair. A rebase would drop it and replay the card's own
    // commits onto the same conflict, so a branch carrying one is brought up to date by merging instead.
    const merging = git(worktree, "rev-list", "--merges", "--max-count=1", "origin/main..HEAD") !== "";
    this.board.append(run.id, merging ? "Merging origin/main into the card branch…\n" : "Rebasing the card branch onto origin/main…\n");
    try {
      if (merging) { git(worktree, "merge", "--no-edit", "origin/main"); return; }
      if (this.hasWorktrunk()) execFileSync(...command(this.wtBin!, ["-C", worktree, "step", "rebase", "origin/main", "--yes"]), { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      else git(worktree, "rebase", "origin/main");
    } catch (error) {
      let conflicted: string[] = [];
      try { conflicted = unmergedFiles(worktree); } catch { /* Keep the rebase error. */ }
      try { git(worktree, merging ? "merge" : "rebase", "--abort"); } catch { /* Nothing in progress. */ }
      const detail = (error as { stderr?: string }).stderr?.toString().trim() || (error instanceof Error ? error.message : String(error));
      if (conflicted.length) this.board.recordMergeFailure(card.id, conflicted, detail);
      const next = conflicted.length ? "Choose Fix conflict with Pi, or resolve it yourself" : "Resolve it";
      throw new Error(`${merging ? "Merge of" : "Rebase onto"} origin/main conflicted${conflicted.length ? ` in ${conflicted.join(", ")}` : ""}; the card branch is unchanged. ${next} in ${worktree}, then run again. ${detail.slice(0, 1000)}`);
    }
  }
  /**
   * CI tests a pull request merged with main, so a failure can come from main's newer commits meeting the card's work
   * even when the two merge cleanly (a new test on main using something the card removed, say). A fix run on a branch
   * behind origin/main gets origin/main merged in first, so the agent sees the tree CI ran. The branch is already on
   * the PR, so it is merged rather than rebased. Returns a sentence for the prompt, or "" when nothing was merged.
   */
  private mergeMainForCiFix(run: Run, worktree: string): string {
    try {
      if (git(worktree, "status", "--porcelain") || isAncestor(worktree, "origin/main", "HEAD")) return "";
    } catch { return ""; }
    const tip = git(worktree, "rev-parse", "origin/main");
    this.board.append(run.id, "Merging origin/main into the card branch so the fix run sees what CI tested…\n");
    try {
      git(worktree, ...commitIdentityArgs(worktree), "merge", "--no-edit", "origin/main");
    } catch {
      let files: string[] = [];
      try { files = unmergedFiles(worktree); } catch { /* Keep going without the list. */ }
      try { git(worktree, "merge", "--abort"); } catch { /* Nothing in progress. */ }
      // Counts toward the board's conflict hotspots. The fix run still targets CI, so the card gets no merge failure.
      if (files.length) this.board.recordConflictEvents(run.cardId, files);
      this.board.append(run.id, `The merge conflicted${files.length ? ` in ${files.join(", ")}` : ""}; the card branch is unchanged.\n`);
      return `Alice tried to merge origin/main (${tip}) into the card branch before this run and it conflicted${files.length ? ` in ${files.join(", ")}` : ""}, so the branch is unchanged. Merge origin/main yourself and commit the merge on the card branch if every conflict is mechanical; otherwise run \`git merge --abort\` and say what decision the conflict needs.`;
    }
    return `Alice already merged origin/main (${tip}) into the card branch for this run, because main moved after the failing commit. Some failures may come from main's newer changes meeting this card's work rather than from the card alone. Keep the merge commit; Alice pushes it with your fix.`;
  }
  private hasWorktrunk() {
    return !!this.wtBin && !!worktrunkVersion(this.wtBin);
  }
  private release(id: string) {
    this.active.delete(id);
    if (!this.active.size) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  /**
   * Runs the repository's Worktrunk pre-start hooks in a freshly created card worktree, starts
   * its post-start hooks in the background, then launches Pi. Approval prompts are skipped because
   * nobody is at a terminal; Pi runs arbitrary commands in the same worktree anyway. If pre-start
   * fails, the fresh worktree and branch are removed so a retry runs the hooks again.
   */
  private runWorktrunkHooks(run: Run, repo: string, root: string, worktree: string, branch: string, launch: () => Run) {
    this.board.append(run.id, "Running Worktrunk pre-start hooks…\n");
    const child = spawn(...command(this.wtBin!, ["-C", worktree, "hook", "pre-start", "--foreground", "--yes"]), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...this.board.sharedCacheEnvFor(repo) } });
    const handle = childHandle(child);
    this.active.set(run.id, handle);
    if (child.pid) this.board.attach(run.id, child.pid, worktree);
    let output = "", done = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => this.terminate(run.id, handle, "10-minute Worktrunk hook timeout"), 10 * 60 * 1000);
    const settle = (failure: string | null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const reason = this.terminationReasons.get(run.id);
      this.terminationReasons.delete(run.id);
      if (!failure && !reason) {
        try { execFileSync(...command(this.wtBin!, ["-C", worktree, "hook", "post-start", "--yes"]), { cwd: worktree, stdio: "ignore", timeout: 30_000 }); }
        catch { this.board.append(run.id, "Worktrunk post-start hooks could not start; continuing without them.\n"); }
        this.board.append(run.id, "Worktrunk hooks done. Starting Pi.\n");
        launch();
        if (!this.active.has(run.id) || this.active.get(run.id) === handle) this.release(run.id);
        return;
      }
      this.release(run.id);
      if (output.trim()) this.board.append(run.id, `${output.trimEnd()}\n`);
      try { git(root, "worktree", "remove", "--force", worktree); git(root, "branch", "-D", branch); }
      catch { /* Keep the hook error; a leftover worktree only means the next attempt skips hooks. */ }
      this.board.finish(run.id, "failed", reason ? `Worktrunk pre-start hooks stopped; Alice sent SIGTERM: ${reason}` : failure!);
    };
    child.on("error", error => settle(`Worktrunk could not start: ${error.message}`));
    child.on("close", (code, signal) => settle(code === 0 ? null : `Worktrunk pre-start hooks failed (${signal ?? code ?? "unknown"}); hook output is in the transcript`));
  }
  /** `taskPrompt` is the whole task, which a narration-free retry starts from when `prompt` is only a continuation. */
  private launchPi(card: Card, run: Run, worktree: string, prompt: string, phase: AgentPhase, handedOff?: HandedOff, taskPrompt = prompt): Run {
    // The wrap-up extension watches this file; Alice writes it once, shortly before the run timeout.
    const wrapUpFile = join(this.dataDir, "wrap-up", run.id);
    // The extension writes Pi's session file path here at startup.
    const sessionRecord = `${wrapUpFile}.session`;
    let piArgs: string[];
    try {
      mkdirSync(join(this.dataDir, "wrap-up"), { recursive: true });
      piArgs = ["--mode", "json", "--session-id", run.sessionId, ...piModelArgs(this.board.agentModelFor(card.repo, phase, run.attempt)), "-e", wrapUpExtension, "--", prompt];
    } catch (error) { this.board.finish(run.id, "failed", String(error)); return this.board.getRun(run.id)!; }
    // IMPRESSION_SESSION=read: the agent gets Impression's memories, but its transcript is never uploaded or extracted.
    const env = { ...process.env, ...this.board.sharedCacheEnvFor(card.repo), ...this.attach?.env, IMPRESSION_SESSION: "read", ALICE_WRAP_UP_FILE: wrapUpFile, ALICE_SESSION_RECORD: sessionRecord };
    const startedAt = Date.now();
    // Pi writes each event as one JSON line, and a line holding a screenshot can run to several MB.
    // Chunks stay as Buffers until a newline arrives, so a long line is concatenated once rather than rescanned per chunk.
    let pending: Buffer[] = [], pendingBytes = 0, overflowed = false, processed = run.eventsOffset;
    let stream = initialPiStreamState(), lastWorktreeSnapshot = "", touchedAt = Date.now();
    let handle: RunHandle | undefined;
    // Process groups and start times are what make a run safe to leave running; elsewhere Pi pipes into the server.
    const detached = process.platform === "linux" || process.platform === "darwin";
    // Stuck detection: the worktree at the last turn end, whether the run is flagged now, and whether the wrap-up went out.
    const stuck = new StuckDetector();
    let lastFingerprint = worktreeFingerprint(worktree), flaggedStuck = false, wrapUpSent = false;
    const steer = (message: string) => {
      mkdirSync(join(this.dataDir, "wrap-up"), { recursive: true });
      writeFileSync(`${wrapUpFile}.tmp`, message);
      renameSync(`${wrapUpFile}.tmp`, wrapUpFile);
    };
    const flagStuck = (reason: string | null) => {
      if (!reason) return;
      flaggedStuck = true;
      this.board.markStuck(run.id, reason);
      // The wrap-up message matters more; once it is sent, a step-back message would only distract from the report.
      let steered = false;
      if (!wrapUpSent) try { steer(STUCK_MESSAGE); steered = true; } catch (error) { console.error(`Could not steer run ${run.id} out of a loop:`, error); }
      this.board.append(run.id, `\nThis run may be stuck: it ${reason}.${steered ? " Alice asked Pi to step back and try a different approach." : ""}\n`);
    };
    // Git runs here, before the batch's transaction opens, so the database is never locked while it works.
    const worktreeSummary = (): string | null => {
      try {
        const paths = [
          execFileSync("git", ["-C", worktree, "diff", "--name-only", "-z", "HEAD", "--"], { encoding: "utf8" }),
          execFileSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }),
        ].flatMap(list => list.split("\0").filter(Boolean)).sort();
        const snapshot = JSON.stringify(paths), changed = snapshot !== lastWorktreeSnapshot;
        lastWorktreeSnapshot = snapshot;
        if (!paths.length || !changed) return null;
        const shown = paths.slice(0, 3).map(path => path.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 80));
        return `worktree: ${paths.length} changed file${paths.length === 1 ? "" : "s"} (${shown.join(", ")}${paths.length > shown.length ? `, +${paths.length - shown.length} more` : ""})\n`;
      } catch { return null; } // A transcript hint must not fail the run if Git is unavailable.
    };
    /** An effect with the Git work it needs done beforehand: a turn end carries the worktree's fingerprint. */
    type Prepared = Exclude<PiEffect, { type: "turnEnded" | "snapshotWorktree" }> | { type: "turnEnded"; edited: boolean; fingerprint: string | null };
    const applyEffect = (effect: Prepared) => {
      switch (effect.type) {
        case "append": this.board.append(run.id, effect.text); break;
        case "recordAgent": this.board.recordAgent(run.id, effect.label); break;
        case "recordUsage": this.board.recordUsage(run.id, effect.usage); break;
        case "recordReport": this.board.recordReport(run.id, effect.text); break;
        case "completeTurn": this.board.completeTurn(run.id); break;
        case "live": this.live.set(run.id, effect.activity); break;
        case "toolStarted": flagStuck(stuck.toolCall(effect.name, effect.args)); break;
        case "turnEnded": {
          const changed = effect.edited || (effect.fingerprint !== null && effect.fingerprint !== lastFingerprint);
          if (effect.fingerprint !== null) lastFingerprint = effect.fingerprint;
          if (changed && flaggedStuck) {
            flaggedStuck = false;
            this.board.markStuck(run.id, null);
            this.board.append(run.id, "\nThe run changed files again, so Alice no longer marks it as maybe stuck.\n");
          }
          flagStuck(stuck.turnEnd(changed));
          break;
        }
      }
    };
    /**
     * Pi's stdout, from the event file or the pipe. Each call applies its whole lines and saves the offset after them
     * in one transaction. If that fails, nothing of the batch is kept, the stream state goes back to before it, and
     * the run is stopped without reading further; false tells the caller to stop feeding it.
     */
    let broken = false;
    const consume = (chunk: Buffer): boolean => {
      // Any output counts as activity; a write every 10s is enough for the board to tell working from quiet.
      if (Date.now() - touchedAt >= 10_000) { touchedAt = Date.now(); this.board.touch(run.id); }
      if (overflowed || broken) return false;
      pending.push(chunk); pendingBytes += chunk.length;
      if (chunk.indexOf(10) < 0) {
        if (pendingBytes > MAX_PI_EVENT_BYTES) {
          overflowed = true; pending = []; pendingBytes = 0;
          stream = { ...stream, protocolError: "Pi event exceeded 500 MB" };
          if (handle) this.terminate(run.id, handle, "Pi event exceeded 500 MB");
          return false;
        }
        return true;
      }
      const data = pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes);
      const before = stream, effects: Prepared[] = [];
      let start = 0, i: number;
      while ((i = data.indexOf(10, start)) >= 0) {
        const line = data.toString("utf8", start, i).replace(/\r$/, ""); start = i + 1;
        const result = reducePiLine(stream, line, { now: Date.now(), worktree });
        stream = result.state;
        for (const effect of result.effects) {
          if (effect.type === "turnEnded") effects.push({ ...effect, fingerprint: worktreeFingerprint(worktree) });
          else if (effect.type !== "snapshotWorktree") effects.push(effect);
          else {
            const text = worktreeSummary();
            if (text) effects.push({ type: "append", text });
          }
        }
      }
      // `data` starts at the first byte not yet applied, so the batch ends `start` bytes on.
      try {
        this.board.applyRunEvents(run.id, detached ? processed + start : null, () => { for (const effect of effects) if (effect.type !== "live") applyEffect(effect); });
      } catch (error) {
        broken = true; pending = []; pendingBytes = 0;
        const message = error instanceof Error ? error.message : String(error);
        stream = { ...before, protocolError: `Alice could not save Pi's events: ${message.slice(0, 300)}` };
        console.error(`Could not save run ${run.id}'s events:`, error);
        if (handle) this.terminate(run.id, handle, "Alice could not save the run's events");
        return false;
      }
      processed += start;
      for (const effect of effects) if (effect.type === "live") applyEffect(effect);
      pending = start < data.length ? [data.subarray(start)] : [];
      pendingBytes = data.length - start;
      return true;
    };
    const { runTimeoutMs, wrapUpLeadMs } = this.timing;
    const timeoutLabel = `${Math.round(runTimeoutMs / 60_000)}-minute run timeout`;
    const timer = setTimeout(() => { if (handle) this.terminate(run.id, handle, timeoutLabel); }, runTimeoutMs);
    // Steer the run to write its report before the timeout kills it; a SIGTERM loses the report and the next attempt starts blind.
    const wrapUpTimer = setTimeout(() => {
      try {
        wrapUpSent = true;
        steer(WRAP_UP_MESSAGE);
        this.board.append(run.id, `\nAlice asked Pi to stop starting new work and write its report: the ${timeoutLabel} is ${Math.round(wrapUpLeadMs / 60_000)} min away.\n`);
      } catch (error) { console.error(`Could not ask run ${run.id} to wrap up:`, error); }
    }, Math.max(0, runTimeoutMs - wrapUpLeadMs));
    const settle = () => {
      clearTimeout(timer); clearTimeout(wrapUpTimer);
      try { const file = readFileSync(sessionRecord, "utf8").trim(); if (file) this.board.recordSessionFile(run.id, file); }
      catch { /* Pi never started its session, or an older extension ran; the next attempt after a timeout starts fresh. */ }
      for (const path of [wrapUpFile, `${wrapUpFile}.tmp`, `${wrapUpFile}.delivered`, sessionRecord]) rmSync(path, { force: true });
      this.live.delete(run.id);
    };
    const couldNotStart = (message: string) => { settle(); this.board.finish(run.id, "failed", `Pi could not start: ${message}`); };
    /** `note` explains an exit the shim could not record. */
    const exited = (code: number | null, signal: string | null, stderr: string, note = "") => {
      settle();
      const reason = this.terminationReasons.get(run.id);
      this.terminationReasons.delete(run.id);
      const { settled, aborted, terminalModelError, protocolError } = stream;
      const ok = code === 0 && settled && !aborted && !terminalModelError && !protocolError && !note;
      // Exit code 143 often means SIGTERM through a shell, but does not identify the sender.
      // Name the call a killed run was stuck in, so a timeout says what ate the time.
      const running = stuckTool(stream);
      const stuck = running ? `; stuck in ${running.name} for ${Math.round((Date.now() - running.since) / 60_000)} min${running.detail ? `: ${running.detail}` : ""}` : "; no tool was running";
      const termination = reason ? `; Alice sent SIGTERM: ${reason}${stuck}`
        : signal || code === 143 ? "; termination source unknown (Alice did not send SIGTERM)" : "";
      const failureKind: ProviderFailureKind | null = terminalModelError ? classifyProviderFailure(terminalModelError) : null;
      const retryPlain = !ok && isOutputDuplicationBlock(terminalModelError) && taskPrompt.includes(NARRATION);
      if (retryPlain) this.board.append(run.id, "\nAnthropic blocked this request as reverse engineering. Alice will retry once in a fresh session without the narration instruction.\n");
      // Pi exits 0 and settles even when the provider rejected its last request, so a provider failure leads the text
      // and the exit status only follows as detail; it must never read as a clean exit.
      const exit = `Pi exited (${signal ?? code ?? "unknown"})${termination}; ${settled ? "settled" : "no settlement event"}${note ? `; ${note}` : ""}`;
      const failure = terminalModelError ? `${terminalModelError} [${failureKind}: ${describeProviderFailure(failureKind!)}]; ${exit}` : exit;
      this.board.finish(run.id, ok ? "review" : "failed", ok ? null : `${failure}${protocolError ? `; ${protocolError}` : ""}${stderr.trim() ? `; stderr: ${stderr.trim().slice(-1500)}` : ""}`, ok ? null : failureKind, !reason && !signal && !protocolError && code === 0);
      if (!ok) console.error(`Pi exit for run ${run.id}: pid=${this.board.getRun(run.id)?.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"} source=${reason ?? "unknown"} elapsedMs=${Date.now() - startedAt}`);
      if (stderr) console.error(`Pi diagnostics for run ${run.id}:`, stderr);
      if (retryPlain) this.retryWithoutNarration(card, run, worktree, taskPrompt.replace(NARRATION, PLAIN_RETRY), phase, handedOff);
      else if (!ok && failureKind === "invalid-history") this.recoverAfterRejection(card, run, handedOff);
    };
    handle = !detached
      ? this.pipePi(run, worktree, piArgs, env, consume, couldNotStart, exited)
      : this.detachPi(run, worktree, piArgs, env, consume, couldNotStart, exited);
    return this.board.getRun(run.id)!;
  }
  /**
   * Without process groups and start times (Windows, other Unixes), Pi stays a child of the server with its stdout
   * piped in, and a server restart still waits for it (or kills it).
   */
  private pipePi(run: Run, worktree: string, args: string[], env: NodeJS.ProcessEnv, consume: (chunk: Buffer) => boolean,
    couldNotStart: (message: string) => void, exited: (code: number | null, signal: string | null, stderr: string) => void): RunHandle | undefined {
    let child: ChildProcess;
    try { child = spawn(...command(this.piBin, args), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"], env }); }
    catch (error) { this.board.finish(run.id, "failed", String(error)); return undefined; }
    const handle = childHandle(child);
    this.active.set(run.id, handle);
    if (child.pid) this.board.attach(run.id, child.pid, worktree);
    let stderr = "";
    child.stdout?.on("data", consume);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", error => couldNotStart(error.message));
    child.on("close", (code, signal) => { this.release(run.id); exited(code, signal, stderr); });
    return handle;
  }
  /**
   * Starts Pi under `run-shim.ts`, detached in its own process group, with its output in `dataDir/runs/<run id>/`.
   * The shim starts Pi only once this server has saved the shim's PID and start time and said `start`, so a Pi
   * that outlives the server can always be found and stopped. While the server lives it tails `events.jsonl` and
   * finishes the run when the shim reports Pi's exit. The run directory goes once the run is recorded.
   */
  private detachPi(run: Run, worktree: string, args: string[], env: NodeJS.ProcessEnv, consume: (chunk: Buffer) => boolean,
    couldNotStart: (message: string) => void, exited: (code: number | null, signal: string | null, stderr: string, note?: string) => void): RunHandle | undefined {
    const dir = runDir(this.dataDir, run.id);
    let child: ChildProcess, events: number;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), "");
      events = openSync(join(dir, "events.jsonl"), "r");
      const shimLog = openSync(join(dir, "shim.log"), "w");
      try { child = spawn(process.execPath, [runShim, dir, this.piBin, ...args], { cwd: worktree, detached: true, stdio: ["pipe", "ignore", shimLog], env }); }
      finally { closeSync(shimLog); }
    } catch (error) { this.board.finish(run.id, "failed", String(error)); return undefined; }
    // The shim may exit before reading the acknowledgement; a write to its closed stdin is not an error here.
    child.stdin?.on("error", () => {});
    const pid = child.pid, startTime = pid ? processStartTime(pid) : null;
    let ended = false, resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const handle: RunHandle = {
      // The whole group: Pi and the tools it started. The shim records how Pi exited.
      signal: () => !ended && !!pid && !!startTime && signalGroup(pid, startTime),
      closed,
    };
    this.active.set(run.id, handle);
    // Without a start time the shim could never be told from a later process with its PID, so Pi must not start.
    const refused = pid && startTime ? null : "Alice could not read the run process's start time, so it did not start Pi";
    if (refused) child.stdin?.end();
    else {
      this.board.attach(run.id, pid!, worktree, startTime);
      child.stdin?.end("start\n");
    }
    // Reads the event file at most EVENT_CHUNK_BYTES per event-loop turn, so a backlog never blocks requests or a Stop.
    let position = run.eventsOffset, pumping = false, reading = true, drained: (() => void) | null = null;
    const pump = () => {
      try {
        const size = fstatSync(events).size;
        if (reading && size > position) {
          const chunk = Buffer.allocUnsafe(Math.min(size - position, EVENT_CHUNK_BYTES));
          const read = readSync(events, chunk, 0, chunk.length, position);
          if (read > 0) {
            position += read;
            if (!consume(read === chunk.length ? chunk : chunk.subarray(0, read))) reading = false;
            if (reading && fstatSync(events).size > position) { setImmediate(pump); return; }
          }
        }
      } catch (error) { console.error(`Could not read run ${run.id}'s events:`, error); }
      pumping = false;
      const next = drained;
      drained = null;
      next?.();
    };
    const kick = () => { if (!pumping) { pumping = true; setImmediate(pump); } };
    // A watch reads new events as soon as Pi writes them; the poll catches anything a watch misses.
    const poll = setInterval(kick, EVENT_POLL_MS);
    let watcher: FSWatcher | undefined;
    try { watcher = watch(join(dir, "events.jsonl"), kick); watcher.on("error", () => watcher?.close()); }
    catch { /* The poll alone still reads every event. */ }
    /** Reads what is left of the event file, then records the run. */
    const end = (finish: () => void) => {
      if (ended) return;
      ended = true;
      clearInterval(poll);
      watcher?.close();
      drained = () => {
        closeSync(events);
        this.release(run.id);
        try { finish(); }
        finally { rmSync(dir, { recursive: true, force: true }); resolveClosed(); }
      };
      kick();
    };
    child.on("error", error => end(() => couldNotStart(`run shim: ${error.message}`)));
    child.on("exit", (code, signal) => end(() => {
      const recorded = readExit(dir), stderr = tail(join(dir, "stderr.log"));
      if (refused) couldNotStart(refused);
      else if (recorded?.error !== undefined) couldNotStart(recorded.error);
      else if (recorded?.started === false) exited(null, recorded.signal, stderr, "stopped before Pi started");
      else if (recorded) exited(recorded.code, recorded.signal, stderr);
      // Killed before it could record Pi's exit (a stop that lands while Node is still starting, say).
      else exited(code, signal, `${stderr}\n${tail(join(dir, "shim.log"))}`, "Alice's run shim exited without recording Pi's exit");
    }));
    return handle;
  }
  /**
   * A rejected session history fails identically on every resume. Hand back the feedback the run took, then start one
   * fresh-session recovery. A recovery run that is rejected again stops here: the card stays Failed with a note, and
   * only an operator's explicit `recover` tries again. Nothing else (billing, auth, other 400s) is retried here.
   */
  private recoverAfterRejection(card: Card, failed: Run, handedOff?: HandedOff) {
    if (handedOff) this.board.restoreCiFeedback(card.id, handedOff);
    if (failed.recoveryOf) {
      this.board.noteCard(card.id, `Attempt ${failed.attempt}, a fresh-session recovery, was rejected by the provider again; Alice will not recover automatically a second time. Inspect the session evidence, then recover again by hand if it is safe`);
      return;
    }
    if (this.draining) { this.board.noteCard(card.id, `The provider rejected attempt ${failed.attempt}'s session history; Alice is restarting, so it did not start a fresh-session recovery. Recover the card by hand`); return; }
    try { this.recover(card.id, "auto"); }
    catch (error) { this.board.noteCard(card.id, `The provider rejected attempt ${failed.attempt}'s session history and Alice could not start a fresh-session recovery: ${error instanceof Error ? error.message : String(error)}`); }
  }
  /**
   * Starts a run in a fresh Pi session for a card whose latest run failed because the provider rejected the session's
   * message history. The card's worktree, branch, edits and review feedback carry over because the run starts in the
   * same worktree with the card's current feedback. The rejected session file and run log stay as evidence, and the
   * recovery is recorded in the card's history and the new run's transcript.
   */
  recover(cardId: string, startedBy: "manual" | "auto" = "manual"): Run {
    const card = this.board.getCard(cardId);
    if (!card) throw new Error("Card not found");
    const failed = this.board.listRuns(cardId)[0];
    if (card.status !== "failed" || failed?.status !== "failed" || failed.failureKind !== "invalid-history")
      throw new Error("Only a failed card whose latest run was rejected for an invalid message history can be recovered in a fresh session");
    const run = this.start(card, "manual", `in a fresh session to recover from attempt ${failed.attempt}'s rejected session history${startedBy === "auto" ? " (automatic)" : ""}`, failed, startedBy === "manual");
    this.board.append(run.id, `Fresh-session recovery of attempt ${failed.attempt}, whose session ${failed.sessionId} the provider rejected. That session and its log are kept as evidence.\n`);
    return this.board.getRun(run.id)!;
  }
  /** Starts the next attempt in a fresh session, since the blocked session's history is full of narration. */
  private retryWithoutNarration(card: Card, blocked: Run, worktree: string, prompt: string, phase: AgentPhase, handedOff?: HandedOff) {
    if (this.draining) {
      this.board.noteCard(card.id, `Anthropic blocked attempt ${blocked.attempt} as reverse engineering; Alice is restarting, so it did not retry without narration`);
      return;
    }
    let run: Run;
    try { run = this.board.claim(card.id, "manual", `without the narration instruction, in a fresh session, because Anthropic blocked attempt ${blocked.attempt} as reverse engineering`, true, blocked.recoveryOf); }
    catch (error) {
      this.board.noteCard(card.id, `Anthropic blocked attempt ${blocked.attempt} as reverse engineering; Alice could not retry without narration: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (blocked.ciFix) this.board.startCiFix(card.id, run.id, blocked.ciFix === 2 ? "conflict" : "ci");
    this.board.append(run.id, `Retry of attempt ${blocked.attempt}, which Anthropic blocked as reverse engineering. This attempt runs in a fresh session without the narration instruction, so the live status line shows only tool activity.\n`);
    this.launchPi(card, run, worktree, prompt, phase, handedOff);
  }
  stop(id: string) {
    const handle = this.active.get(id);
    if (!handle) throw new Error("This run is not owned by the current server process");
    this.terminate(id, handle, "manual stop");
  }
  get activeCount() { return this.active.size; }
  /** Each card's live activity, or null for a card whose run is not in progress or has not used a tool yet. */
  withLive<T extends { id: string }>(cards: T[]): (T & { live: LiveActivity | null })[] {
    const byCard = new Map<string, LiveActivity>();
    for (const [runId, live] of this.live) {
      const run = this.active.has(runId) ? this.board.getRun(runId) : undefined;
      if (run) byCard.set(run.cardId, live);
    }
    return cards.map(card => ({ ...card, live: byCard.get(card.id) ?? null }));
  }
  /** Ids of the runs in progress. */
  get activeRunIds(): string[] { return [...this.active.keys()]; }
  /** Refuse new runs and resolve once every active Pi child has exited on its own. */
  drain(): Promise<void> {
    this.draining = true;
    if (!this.active.size) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  /** Refuse new runs without waiting for the active ones, so a shutdown can finish pushes that might start a hook-fix run. */
  stopStarts(): void { this.draining = true; }
  async shutdown(reason = "server shutdown") {
    await Promise.all([...this.active].map(([id, handle]) => { this.terminate(id, handle, reason); return handle.closed; }));
  }
}
