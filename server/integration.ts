import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Board, type Card } from "./board.js";
import { boardGithubRepo, commentOnPullRequest, fetchOrigin, type GitHub, postPullRequestComment } from "./github.js";
import { cardTitle, pullRequestBody, readPullRequestRules } from "./pr-draft.js";
import { semanticTitleProblem } from "../src/pr-title.js";
import { githubMarkdown } from "./github-markdown.js";
import { githubRepo } from "./github-url.js";
import { commitIdentityArgs } from "./git-identity.js";
import { featureOffMessage } from "../src/features.js";
import { cardBranch, cardBranches } from "./legacy-names.js";
import { behindOriginMessage, compareWithOriginMain, fetchOriginBestEffort, hasOrigin, syncMainWithOrigin } from "./origin.js";

function gitCommand(repo: string, args: string[], index?: string, raw = false, maxBuffer = 8 * 1024 * 1024): string {
  try {
    const output = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env, maxBuffer });
    return raw ? output : output.trim();
  } catch (error) {
    const result = error as { stderr?: Buffer; stdout?: Buffer };
    const detail = (result.stderr?.toString() || result.stdout?.toString() || "Git command failed").trim();
    const operation = args[0] === "-c" ? args.find(arg => arg === "merge" || arg === "commit") ?? "git" : args[0];
    throw new Error(`${operation} failed: ${detail.slice(0, 4000)}`);
  }
}
function git(repo: string, ...args: string[]): string { return gitCommand(repo, args); }
/**
 * `gitCommand` without blocking the event loop, for work that runs on a timer. Under load one git call can take
 * seconds, and a synchronous one stalls every request the server is handling meanwhile.
 */
function gitCommandAsync(repo: string, args: string[], raw = false, index?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env }, (error, stdout, stderr) => {
      if (!error) return resolve(raw ? stdout : stdout.trim());
      const detail = (stderr || stdout || "Git command failed").trim();
      reject(Object.assign(new Error(`${args[0]} failed: ${detail.slice(0, 4000)}`), { status: typeof error.code === "number" ? error.code : undefined }));
    });
  });
}
const readGit = (repo: string, ...args: string[]) => gitCommandAsync(repo, args);
async function isAncestorAsync(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await readGit(repo, "merge-base", "--is-ancestor", ancestor, descendant); return true; }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
}
/**
 * A three-way merge done on objects only (`git merge-tree`), so nothing in any worktree or ref changes. Returns the
 * merged tree, or the paths that conflict. `sides` are the two commits or trees to merge, optionally preceded by
 * `--merge-base=<tree-ish>`.
 */
function mergeTreeAsync(repo: string, sides: string[]): Promise<{ tree: string; conflicts: string[] }> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, "merge-tree", "--write-tree", "--name-only", "-z", ...sides], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      // Exit 1 is a merge with conflicts; anything else is Git failing.
      if (error && error.code !== 1) return reject(new Error(`merge-tree failed: ${(stderr || stdout || error.message).trim().slice(0, 4000)}`));
      const [tree, ...rest] = stdout.split("\0");
      const end = rest.indexOf("");
      resolve({ tree: tree.trim(), conflicts: error ? [...new Set(rest.slice(0, end < 0 ? rest.length : end))] : [] });
    });
  });
}
/**
 * Paths an update from tree `from` to tree `to` would create in `worktree` where a local file already sits that Git
 * does not track, such as an ignored `.env` that main starts tracking. `from` holds every file Git sees (`add -A`),
 * so anything already on disk at an added path, or a file where an added path needs a directory, is ignored.
 * `read-tree -u` would overwrite those without asking.
 */
async function ignoredCollisions(worktree: string, from: string, to: string): Promise<string[]> {
  const added = (await gitCommandAsync(worktree, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=A", from, to], true)).split("\0").filter(Boolean);
  const kind = (path: string) => { try { return lstatSync(join(worktree, path)).isDirectory() ? "dir" : "file"; } catch { return ""; } };
  return added.filter(path => {
    const parts = path.split("/");
    return !!kind(path) || parts.slice(0, -1).some((_, i) => kind(parts.slice(0, i + 1).join("/")) === "file");
  });
}
/** What happened to one card that depends on a card that just merged; see `Integration.updateDependents`. */
export type DependentUpdate = { cardId: string; outcome: "updated" | "current" | "conflict" | "deferred" | "skipped"; detail: string };
/** What `location` reads from Git to confirm a card worktree is the card's, on its branch, with no conflicts. */
type WorktreeFacts = { repoTop: string; worktreeTop: string; repoCommon: string; worktreeCommon: string; branch: string; unmerged: string };
const worktreeArgs = {
  top: ["rev-parse", "--show-toplevel"], common: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  branch: ["symbolic-ref", "--short", "HEAD"], unmerged: ["ls-files", "-u"],
} as const;
function worktreeProblem(facts: WorktreeFacts, repo: string, worktree: string, cardId: string): string | null {
  if (realpathSync.native(facts.repoTop) !== realpathSync.native(repo) || realpathSync.native(facts.worktreeTop) !== realpathSync.native(worktree) ||
    realpathSync.native(facts.repoCommon) !== realpathSync.native(facts.worktreeCommon) || !cardBranches(cardId).includes(facts.branch)) return "Card worktree is not on its expected branch in this repository";
  if (facts.unmerged) return "Resolve conflicts in the card worktree before review";
  return null;
}
/**
 * What auto-review needs of a diff: the changed paths and, when asked, the patch's size. No patches are held and no size cap applies.
 * `work` names the reviewed run and its tree. `git add -A` leaves out untracked files Git ignores, so build output does not
 * change it; every tracked file counts, ignored or not. Unlike `fingerprint`, it ignores where local main is.
 */
export type ReviewSummary = { fingerprint: string; work: string; paths: string[]; patchChars: number | null; unsupported: boolean };
export type ReviewDiff = { fingerprint: string; files: { path: string; patch: string }[] };
export class IntegrationConflictError extends Error {
  readonly code = "merge_conflict";
  constructor(readonly cardId: string, readonly files: string[], readonly details: string) {
    super("Changes conflict with current main");
  }
}
function clean(repo: string) { return git(repo, "status", "--porcelain") === ""; }
function hasCommit(repo: string, rev: string) {
  try { execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { stdio: "ignore" }); return true; }
  catch { return false; }
}
/** A Done card Alice merged into local main, offered as "Publish as PR". `blocker` says why it cannot be published. */
export type LocalMerge = { card: Card; candidate: string; commits: number; blocker: string };
/** Local main has commits origin/main lacks. `resettable` means they are only published card merges. */
export type MainRecovery = { tip: string; originMain: string; recoveryBranch: string; localCommits: number; resettable: boolean; reason: string };
/** Why a locally merged card's candidate cannot become a PR as it is, or "". */
function publishBlocker(repo: string, card: Card, candidate: string): string {
  if (card.prOverrideUrl) return `Linked to ${card.prOverrideUrl}; Alice only pushes ${cardBranch(repo, card.id)}`;
  if (!hasCommit(repo, candidate)) return `The approved commit ${candidate.slice(0, 12)} is no longer in the repository`;
  // The candidate was built on local main. Other local merges under it would ride along in this PR.
  const merges = git(repo, "rev-list", "--merges", `refs/remotes/origin/main..${candidate}`).split("\n").filter(Boolean);
  if (merges.length) return `${cardBranch(repo, card.id)} includes ${merges.length} merge commit${merges.length === 1 ? "" : "s"} from local main that origin/main lacks (${git(repo, "log", "-1", "--format=%s", merges[0])}), which would land in this pull request. Rebase the card branch onto origin/main yourself, then publish`;
  return "";
}
function isAncestor(repo: string, ancestor: string, descendant: string) {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/**
 * Where `candidate` stands against `branch` on origin, after a fetch. "push" when the branch is new there or a plain
 * push fast-forwards it; "on-origin" when origin's branch already contains the candidate (someone pushed to the pull
 * request, for example merging main into it, and Alice has nothing new). When both sides hold commits the other
 * lacks, throws instead of letting Git reject the push, naming what origin has so nobody's work is overwritten.
 */
function remoteBranchState(repo: string, branch: string, candidate: string, resolve: string | null): "push" | "on-origin" | "diverged" {
  const remote = `refs/remotes/origin/${branch}`;
  if (!hasCommit(repo, remote) || isAncestor(repo, remote, candidate)) return "push";
  if (isAncestor(repo, candidate, remote)) return "on-origin";
  if (resolve === null) return "diverged";
  const theirs = Number(git(repo, "rev-list", "--count", `${candidate}..${remote}`));
  const ours = Number(git(repo, "rev-list", "--count", `${remote}..${candidate}`));
  const latest = git(repo, "log", "-1", "--format=%h %s (%an)", remote);
  throw new Error(`${branch} on origin has ${theirs} commit${theirs === 1 ? "" : "s"} this card lacks (latest: ${latest}), and the card has ${ours} that origin lacks. Someone pushed to the pull request; Alice will not overwrite it. ${resolve}`);
}

/** Why the card worktree cannot take an automatic merge of `origin/<branch>`, or "" when it is safe to try. */
function mergeBlocker(worktree: string, branch: string): string {
  const gitPath = (name: string) => resolve(worktree, git(worktree, "rev-parse", "--git-path", name));
  for (const [name, what] of [["MERGE_HEAD", "a merge"], ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"]] as const)
    if (existsSync(gitPath(name))) return `the card worktree is in the middle of ${what}`;
  let head = "";
  try { head = git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* Detached HEAD. */ }
  if (head !== branch) return `the card worktree is ${head ? `on branch ${head}` : "in detached HEAD"}, not ${branch}`;
  if (!clean(worktree)) return "the card worktree has uncommitted changes";
  return "";
}

/**
 * Merges `origin/<branch>` into the card worktree when both sides hold commits the other lacks, keeping every
 * commit on both sides; nothing is pushed or rewritten. A conflict is aborted so the worktree is exactly as it was,
 * and an unsafe worktree is left alone. Either throws with what to do. The merged tree was never reviewed, so the
 * caller stops after this: approval, verification and review run again on the result.
 */
function mergeRemoteBranch(worktree: string, branch: string, scratch = false): { merged: number; head: string } {
  const remote = `refs/remotes/origin/${branch}`;
  const theirs = Number(git(worktree, "rev-list", "--count", `HEAD..${remote}`)), ours = Number(git(worktree, "rev-list", "--count", `${remote}..HEAD`));
  const blocker = scratch ? "" : mergeBlocker(worktree, branch);
  if (blocker) throw new Error(`${branch} on origin has ${theirs} commit${theirs === 1 ? "" : "s"} this card lacks, and the card has ${ours} that origin lacks, but Alice could not merge them: ${blocker}. Nothing was changed or pushed. Fix that in ${worktree}, then approve again`);
  try {
    git(worktree, ...commitIdentityArgs(worktree), "merge", "--no-edit", "--no-ff", "-m", `Merge origin/${branch} into ${branch}`, remote);
  } catch (error) {
    let files = "";
    try { files = git(worktree, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean).join(", "); } catch { /* Not mid-merge. */ }
    try { git(worktree, "merge", "--abort"); } catch { /* Nothing in progress. */ }
    const detail = error instanceof Error ? error.message.slice(0, 500) : String(error);
    throw new Error(`${branch} on origin has ${theirs} commit${theirs === 1 ? "" : "s"} this card lacks, and the card has ${ours} that origin lacks. Merging them ${files ? `conflicts in ${files}` : `failed (${detail})`}. Alice aborted the merge and changed nothing; nothing was pushed. ${scratch ? `Reconcile origin/${branch} with the approved commit yourself, then publish again` : `Merge origin/${branch} into ${worktree} yourself and resolve the conflict, then approve again`}`);
  }
  return { merged: theirs, head: git(worktree, "rev-parse", "HEAD") };
}

// The title is user text. It reaches Git only as an argv entry, never through a shell.
export function mergeMessage(card: Pick<Card, "id" | "title">, branch = `alice/${card.id}`): string[] {
  const prefix = "Merge card: ", limit = 72 - prefix.length;
  const title = card.title.replace(/\s+/g, " ").trim() || "(untitled)";
  const chars = [...title];
  const subject = prefix + (chars.length > limit ? chars.slice(0, limit - 1).join("").trimEnd() + "…" : title);
  return ["-m", subject, "-m", `Card: ${card.id}\nBranch: ${branch}`];
}

/**
 * What Alice is doing while it pushes a card to GitHub: the current step and the output Git and the repository's
 * pre-push hooks printed so far. Kept per card after it finishes, so the board can show how the last push ended.
 */
export type PushProgress = { step: string; log: string[]; startedAt: string; finishedAt: string | null; error: string | null };
const progressLogLines = 400;

/**
 * `git push` without blocking the server, streaming stdout and stderr together into `onLine`. A pre-push hook's own
 * stdout is part of the push output, so a failure message carries everything it printed, not only stderr. Git passes
 * the hook's stdout to its stdout, a separate pipe, so each stream's lines stay in order but the two interleave as read. `\r` progress redraws replace the line they redraw.
 */
/** A failed `git push`. `hookFailed` when a pre-push hook refused it, as opposed to the remote or the network. */
export class PushError extends Error {
  constructor(message: string, readonly output: string, readonly hookFailed: boolean) { super(message); }
}
/** A pre-push hook refused the push of `sha`, which Alice had committed from the card's reviewed work. */
export class PushHookError extends PushError {
  constructor(error: PushError, readonly sha: string) { super(error.message, error.output, true); }
}
/** The repository's pre-commit or commit-msg hook refused the commit Alice made of the card's work, so nothing was committed. */
export class CommitHookError extends Error {
  constructor(message: string, readonly output: string) { super(message); }
}

/** Kills a child started with `detached`, and what it started, such as a hook's test run. */
function killGroup(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGTERM"); }
  catch { child.kill(); }
}

/** Git without blocking the server, for commands that run hooks. Rejects with the end of their output; aborting kills them. */
function gitAsync(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Cancelled")); return; }
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, detached: process.platform !== "win32" });
    let stdout = "", output = "";
    const abort = () => killGroup(child);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); output = (output + chunk.toString()).slice(-8000); });
    child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); });
    child.on("error", error => { signal.removeEventListener("abort", abort); reject(error); });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new Error("Cancelled"));
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${args.find(arg => !arg.includes("=") && arg !== "-c") ?? "git"} failed: ${output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim() || `exit code ${code}`}`));
    });
  });
}

/**
 * `flags` go before the remote: `--dry-run` to run only the pre-push hook, `--no-verify` to skip it. Aborting
 * `signal` kills Git and the hook it is running (their whole process group).
 */
export function pushBranch(cwd: string, refspec: string, onLine: (line: string, replace: boolean) => void, options: { flags?: string[]; signal?: AbortSignal } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("Cancelled")); return; }
    const child = spawn("git", ["-C", cwd, "push", "--progress", ...(options.flags ?? []), "origin", refspec], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, detached: !!options.signal && process.platform !== "win32" });
    const abort = () => killGroup(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    const output: string[] = [];
    // Per stream: text not yet ended by a newline, and whether the next line redraws the last (after a bare \r).
    const state = { stdout: { pending: "", redraw: false }, stderr: { pending: "", redraw: false } };
    const emit = (line: string, replace: boolean) => {
      const text = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (replace && output.length) output[output.length - 1] = text; else output.push(text);
      onLine(text, replace);
    };
    const read = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const current = state[stream];
      const parts = (current.pending + chunk.toString("utf8")).split(/(\r\n|\r|\n)/);
      current.pending = parts.pop() ?? "";
      for (let i = 0; i < parts.length; i += 2) {
        emit(parts[i], current.redraw);
        current.redraw = parts[i + 1] === "\r";
      }
    };
    child.stdout.on("data", read("stdout"));
    child.stderr.on("data", read("stderr"));
    child.on("error", reject);
    child.on("close", code => {
      options.signal?.removeEventListener("abort", abort);
      for (const stream of ["stdout", "stderr"] as const) if (state[stream].pending) emit(state[stream].pending, state[stream].redraw);
      if (options.signal?.aborted) { reject(new Error("Cancelled")); return; }
      if (code === 0) { resolve(); return; }
      const detail = output.filter(line => line.trim()).join("\n") || `git push exited with code ${code}`;
      // The end of the output names the failing check; keep it when the output is long.
      // Git prints "! [rejected]" lines when the remote refuses and "fatal:" when it cannot connect. A hook failing
      // prints neither: only the hook's own output, then "error: failed to push some refs".
      const hookFailed = !output.some(line => /^\s*! \[|^(fatal|remote):/.test(line));
      const body = (detail.length > 6000 ? "…" + detail.slice(-6000) : detail);
      reject(new PushError(`push failed: ${hookFailed ? "the repository's pre-push hook refused it.\n\n" : ""}${body}`, detail, hookFailed));
    });
  });
}

export class Integration {
  private reconciliationErrors = new Set<string>();
  private progress = new Map<string, PushProgress>();
  /** Non-blocking problems seen while approving, such as an offline fetch. Kept for inspection; also logged. */
  readonly warnings: string[] = [];
  /** Called with "merge" or "pr" when Alice merges a card into local main or opens or updates its pull request. Used for usage telemetry. */
  onDelivered: (kind: "merge" | "pr") => void = () => {};
  constructor(private board: Board, readonly dataDir: string, private fetchTimeoutMs = 30_000) {}

  /** The current or last push of `cardId` to GitHub, or null when Alice has not pushed it since starting. */
  pushProgress(cardId: string): PushProgress | null { return this.progress.get(cardId) ?? null; }

  /** Runs `work` as a tracked push of `cardId`: steps and push output go to `pushProgress`, and so does the outcome. */
  private async trackPush<T>(cardId: string, work: (step: (name: string) => void, push: (cwd: string, refspec: string, flags?: string[]) => Promise<void>) => Promise<T>): Promise<T> {
    const entry: PushProgress = { step: "Starting", log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.progress.set(cardId, entry);
    const step = (name: string) => { entry.step = name; };
    const push = (cwd: string, refspec: string, flags?: string[]) => pushBranch(cwd, refspec, (line, replace) => {
      if (replace && entry.log.length) entry.log[entry.log.length - 1] = line; else entry.log.push(line);
      if (entry.log.length > progressLogLines) entry.log.splice(0, entry.log.length - progressLogLines);
    }, { flags });
    try {
      const result = await work(step, push);
      entry.step = "Done";
      return result;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  }

  /** The card's latest reviewed (or, with `allowFailed`, failed) run and its worktree, before any Git check. */
  private reviewedRun(card: Card, allowFailed: boolean) {
    const run = this.board.listRuns(card.id)[0];
    if (!run || !run.worktree || !(card.status === "review" && run.status === "review" ||
      allowFailed && card.status === "failed" && run.status === "failed")) throw new Error("Only a reviewed run can be inspected or approved");
    const repo = card.repo, worktree = join(this.dataDir, "worktrees", card.id);
    if (!existsSync(worktree) || realpathSync.native(worktree) !== realpathSync.native(run.worktree)) throw new Error("Card worktree is missing or has moved");
    return { repo, worktree, run };
  }
  private location(card: Card, allowFailed = false) {
    const found = this.reviewedRun(card, allowFailed), { repo, worktree } = found;
    const problem = worktreeProblem({
      repoTop: git(repo, ...worktreeArgs.top), worktreeTop: git(worktree, ...worktreeArgs.top),
      repoCommon: git(repo, ...worktreeArgs.common), worktreeCommon: git(worktree, ...worktreeArgs.common),
      branch: git(worktree, ...worktreeArgs.branch), unmerged: git(worktree, ...worktreeArgs.unmerged),
    }, repo, worktree, card.id);
    if (problem) throw new Error(problem);
    return found;
  }
  /** `location` without blocking the event loop. */
  private async locationAsync(card: Card, allowFailed = false) {
    const found = this.reviewedRun(card, allowFailed), { repo, worktree } = found;
    const [repoTop, worktreeTop, repoCommon, worktreeCommon, branch, unmerged] = await Promise.all([
      readGit(repo, ...worktreeArgs.top), readGit(worktree, ...worktreeArgs.top), readGit(repo, ...worktreeArgs.common),
      readGit(worktree, ...worktreeArgs.common), readGit(worktree, ...worktreeArgs.branch), readGit(worktree, ...worktreeArgs.unmerged)]);
    const problem = worktreeProblem({ repoTop, worktreeTop, repoCommon, worktreeCommon, branch, unmerged }, repo, worktree, card.id);
    if (problem) throw new Error(problem);
    return found;
  }


  private snapshot(card: Card, includeFiles: boolean, summary?: { measureChars: boolean }) {
    const { repo, worktree, run } = this.location(card);
    // The fingerprint keys on the merge base, not the branch tip: committing the reviewed work (as opening a PR
    // does) moves HEAD without changing the tree, and must not mark the loaded diff stale.
    const main = git(repo, "rev-parse", "main"), branch = git(worktree, "rev-parse", "HEAD");
    const base = git(worktree, "merge-base", main, branch);
    const temp = mkdtempSync(join(tmpdir(), "alice-review-"));
    try {
      const index = join(temp, "index");
      // Seed from the worktree's own index: its stat cache lets `add -A` rehash only changed files.
      // A fresh read-tree makes git rehash the whole tree (about 0.5s on a 3 GB worktree).
      try {
        const source = resolve(worktree, git(worktree, "rev-parse", "--git-path", "index"));
        copyFileSync(source, index);
        // Git decides whether an entry is "racily clean" by comparing file times with the index file's own
        // time, so the copy must keep the original's, or a same-second edit could be missed.
        const { atime, mtime } = statSync(source);
        utimesSync(index, atime, mtime);
      }
      catch { gitCommand(worktree, ["read-tree", "HEAD"], index); }
      gitCommand(worktree, ["add", "-A"], index);
      const tree = gitCommand(worktree, ["write-tree"], index);
      const fingerprint = createHash("sha256").update(JSON.stringify({ run: run.id, main, base, tree })).digest("hex");
      const work = `${run.id}:${tree}`;
      if (!includeFiles && !summary) return { fingerprint, work, tree, main, files: [] as ReviewDiff["files"], paths: [] as string[], patchChars: null as number | null, unsupported: false };
      const paths = gitCommand(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, tree], undefined, true).split("\0").filter(Boolean);
      if (summary) {
        let patchChars: number | null = null;
        // A diff too big for the buffer counts as infinitely large, so a board's size limit still catches it.
        if (summary.measureChars && paths.length) {
          try { patchChars = gitCommand(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", base, tree], undefined, true, 512 * 1024 * 1024).length; }
          catch { patchChars = Number.POSITIVE_INFINITY; }
        }
        // Binary files, symlinks and submodules need a person; modes and numstat show them without reading patches.
        const raw = paths.length ? gitCommand(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--raw", "--numstat", "--no-color", base, tree], undefined, true, 64 * 1024 * 1024) : "";
        const unsupported = /^:(120000|160000) |^:\d+ (120000|160000) |^-\t-\t/m.test(raw);
        return { fingerprint, work, tree, main, files: [] as ReviewDiff["files"], paths, patchChars, unsupported };
      }
      if (paths.length > 200) throw new Error("Review has more than 200 changed files; inspect the worktree outside Alice");
      // One diff for every file, split at each header, instead of one git process per file. Git lists files
      // and emits patches in the same path order; if the counts ever disagree, fall back to per-file diffs.
      const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", base, tree];
      const patches = gitCommand(worktree, diffArgs, undefined, true).split(/^(?=diff --git )/m).filter(Boolean);
      const files = paths.map((path, i) => ({ path, patch: patches.length === paths.length ? patches[i].trim() : gitCommand(worktree, [...diffArgs, "--", path]) }));
      if (files.reduce((size, file) => size + file.patch.length, 0) > 2_000_000) throw new Error("Review diff exceeds 2 MB; inspect the worktree outside Alice");
      return { fingerprint, work, tree, main, files, paths, patchChars: null as number | null, unsupported: false };
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }

  // Git refuses a fast-forward that would overwrite uncommitted edits at the repository root. Name the overlap
  // before approval starts so it fails early and clearly instead of as a raw "merge failed" after verification.
  localConflicts(card: Card): string[] {
    const { repo, worktree } = this.location(card);
    const fields = gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true).split("\0");
    const dirty: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i];
      if (entry.length < 4) continue;
      dirty.push(entry.slice(3));
      if (entry[0] === "R" || entry[0] === "C") dirty.push(fields[++i]); // Renames and copies carry their source path next.
    }
    if (!dirty.length) return [];
    const { tree } = this.snapshot(card, false);
    const base = git(worktree, "merge-base", git(repo, "rev-parse", "main"), git(worktree, "rev-parse", "HEAD"));
    const changed = gitCommand(worktree, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, tree], undefined, true).split("\0").filter(Boolean);
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b.endsWith("/") ? b : b + "/") || b.startsWith(a.endsWith("/") ? a : a + "/");
    return [...new Set(dirty.filter(path => changed.some(file => overlaps(path, file))))];
  }

  // Cheap staleness check: the fingerprint alone, without building any patches.
  reviewFingerprint(card: Card): string { return this.snapshot(card, false).fingerprint; }

  /** The fingerprint and the work it covers (run and tree), from one snapshot. */
  reviewState(card: Card): { fingerprint: string; work: string } {
    const { fingerprint, work } = this.snapshot(card, false);
    return { fingerprint, work };
  }

  /** The paths that differ between two `work` values, to say what changed. Empty when the run changed or Git cannot tell. */
  workChanges(card: Card, before: string, after: string): string[] {
    const [run, from] = before.split(":"), [nextRun, to] = after.split(":");
    if (run !== nextRun || !from || !to) return [];
    try { return gitCommand(this.location(card).worktree, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", from, to], undefined, true).split("\0").filter(Boolean); }
    catch { return []; }
  }

  /** Changed paths, and the patch size when `measureChars`, without the diff viewer's 200-file and 2 MB caps. */
  reviewSummary(card: Card, measureChars: boolean): ReviewSummary {
    const { fingerprint, work, paths, patchChars, unsupported } = this.snapshot(card, false, { measureChars });
    return { fingerprint, work, paths, patchChars, unsupported };
  }

  /** Notes how many files the card's reviewed run changes, so Review tiles can say Approve or Accept findings. Best effort. */
  recordChangedFiles(card: Card): void {
    const run = this.board.listRuns(card.id)[0];
    if (card.status !== "review" || run?.status !== "review") return;
    try { this.board.recordChangedFiles(run.id, this.reviewSummary(card, false).paths.length); } catch { /* The tile just stays unlabeled. */ }
  }

  review(card: Card): ReviewDiff {
    const { fingerprint, files } = this.snapshot(card, true);
    return { fingerprint, files };
  }

  // A merge parent proves the branch was deliberately integrated. An old, unchanged
  // branch tip being an ancestor of main does not. Do not count an "ours" merge
  // whose result tree is identical to its first parent.
  private reconciling: Promise<void> | null = null;
  /**
   * Marks cards whose work someone merged into local main outside Alice. Runs on the auto-review timer with async
   * Git, so it never stalls the server; a call while one is still running waits for that one instead of starting another.
   */
  reconcileExternallyMerged(): Promise<void> {
    this.reconciling ??= this.reconcile().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  private async reconcile(): Promise<void> {
    for (const { card } of this.board.listExternalMergeCandidates()) {
      try {
        const { repo, worktree, run } = await this.locationAsync(card, true);
        const status = () => gitCommandAsync(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"], true);
        if (await status() || await readGit(worktree, "ls-files", "-u")) continue;
        const candidate = await readGit(worktree, "rev-parse", "HEAD");
        if (!await isAncestorAsync(repo, candidate, "main")) continue;
        const main = await readGit(repo, "rev-parse", "main");
        const merges = (await readGit(repo, "rev-list", "--first-parent", "--parents", "--merges", `${candidate}..${main}`)).split("\n").filter(Boolean).map(line => line.split(" "));
        let merged: string[] | undefined;
        for (const [merge, firstParent, ...others] of merges) {
          if (others.includes(candidate) && await readGit(repo, "rev-parse", `${merge}^{tree}`) !== await readGit(repo, "rev-parse", `${firstParent}^{tree}`)) { merged = [merge, firstParent, ...others]; break; }
        }
        if (!merged || await readGit(repo, "rev-parse", "main") !== main || await readGit(worktree, "rev-parse", "HEAD") !== candidate || await status()) continue;
        // Git ran while the card could change; record only if it is still a candidate.
        if (!this.board.listExternalMergeCandidates().some(item => item.card.id === card.id)) continue;
        this.board.recordExternalIntegration(card.id, run.id, candidate, merged[0]);
        this.reconciliationErrors.delete(card.id);
        this.afterMerge(card.id);
        console.log(`Reconciled externally merged card ${card.id} at ${merged[0]}`);
      } catch (error) {
        // Git worktrees can disappear independently of Alice. Leave ambiguous cards unchanged.
        if (!this.reconciliationErrors.has(card.id)) console.error(`Could not reconcile card ${card.id}: ${String(error)}`);
        this.reconciliationErrors.add(card.id);
      }
    }
  }


  private dependentUpdates: Promise<unknown> = Promise.resolve();
  /**
   * After `parentId` merges (Approve, its pull request, or by hand), brings every Review card that depends on it up to
   * date with main, so it does not conflict later. Updates run one at a time, queued behind earlier ones.
   */
  updateDependents(parentId: string): Promise<DependentUpdate[]> { return this.queueDependentWork(() => this.updateDependentsNow(parentId)); }
  /**
   * Retries the updates deferred because the card was busy when its parent merged (see `updateDependent`), for cards
   * that are back in Review and free. The auto-review tick calls it before starting reviews, so a card's next review
   * sees current main.
   */
  retryDeferredDependents(): Promise<DependentUpdate[]> { return this.queueDependentWork(() => this.retryDeferredNow()); }
  private queueDependentWork(work: () => Promise<DependentUpdate[]>): Promise<DependentUpdate[]> {
    const next = this.dependentUpdates.then(work);
    this.dependentUpdates = next.catch(() => {});
    return next;
  }
  /** Resolves once every dependent update queued so far has finished. */
  async dependentUpdatesSettled(): Promise<void> { await this.dependentUpdates; }
  /** Starts `updateDependents` without waiting for it; a merge never fails because a dependent could not follow. */
  private afterMerge(parentId: string) {
    if (!this.board.listDependencies(parentId).dependents.some(card => card.status === "review")) return;
    this.updateDependents(parentId).catch(error => console.error(`Could not update the cards that depend on ${parentId}: ${String(error)}`));
  }
  private async updateDependentsNow(parentId: string): Promise<DependentUpdate[]> {
    const parent = this.board.getCard(parentId);
    if (!parent) return [];
    const results: DependentUpdate[] = [];
    for (const ref of this.board.listDependencies(parentId).dependents) {
      const card = this.board.getCard(ref.id);
      if (card?.status === "review") results.push(await this.updateDependentNoted(card, parent));
    }
    return results;
  }
  private async retryDeferredNow(): Promise<DependentUpdate[]> {
    const results: DependentUpdate[] = [];
    for (const { cardId, parentId } of this.board.listDeferredDependentUpdates()) {
      const card = this.board.getCard(cardId), parent = this.board.getCard(parentId);
      // A card that was sent back keeps waiting until its next run reaches Review.
      if (!card || !parent || card.status === "done" || card.status === "archived") this.board.clearDeferredDependentUpdate(cardId);
      else if (card.status === "review") results.push(await this.updateDependentNoted(card, parent));
    }
    return results;
  }
  /** `updateDependent`, with what happened noted on the card. Anything but a deferral settles a waiting update. */
  private async updateDependentNoted(card: Card, parent: Card): Promise<DependentUpdate> {
    let result: DependentUpdate;
    try { result = await this.updateDependent(card, parent); }
    catch (error) { result = { cardId: card.id, outcome: "skipped", detail: `Alice could not bring this card up to date after "${parent.title}" merged: ${error instanceof Error ? error.message : String(error)}` }; }
    if (result.outcome !== "deferred") this.board.clearDeferredDependentUpdate(card.id);
    if (result.outcome !== "current" && result.detail) this.board.noteCard(card.id, result.detail);
    return result;
  }
  /**
   * Merges current main into one dependent card's worktree, keeping its uncommitted work uncommitted. Review
   * worktrees usually hold the agent's work as uncommitted changes, which a plain rebase or merge would refuse, so
   * the merge is first worked out on Git objects alone (`merge-tree`): the branch with main, then the uncommitted
   * work on top of that. A conflict in either records the usual merge failure and changes nothing. A clean result
   * moves the branch (a fast-forward, or a merge commit when the branch has commits of its own) and updates the files
   * with `read-tree -m -u`, which refuses rather than overwrite a file edited after the snapshot. Staged changes are
   * merged the same way on their own and stay staged. Everything that could stop the update (a conflict in the work or
   * in what is staged, an ignored local file in the way) is found before anything changes, and changes nothing.
   */
  private async updateDependent(card: Card, parent: Card): Promise<DependentUpdate> {
    const result = (outcome: DependentUpdate["outcome"], detail: string): DependentUpdate => ({ cardId: card.id, outcome, detail });
    const after = `after "${parent.title}" merged`;
    const run = this.board.listRuns(card.id)[0];
    if (run?.status !== "review") return result("current", "");
    // GitHub already tests an open pull request against main, and Alice sends its conflicts back from there.
    if (card.prState === "OPEN" || card.prOverrideUrl) return result("current", "");
    const busy = () => this.board.getApproval(card.id) ? "an approval is in progress" : this.board.getAutoReviewJob(run.id)?.state === "running" ? "an agent review is in progress" : "";
    // Its worktree is in use. It is brought up to date once that finishes; see `retryDeferredDependents`.
    const defer = () => {
      const why = busy();
      return result("deferred", this.board.deferDependentUpdate(card.id, parent.id) ? `Not brought up to date with main ${after} yet: ${why}. Alice updates it once that finishes` : "");
    };
    if (busy()) return defer();
    const { repo, worktree } = await this.locationAsync(card);
    for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
      if (existsSync(resolve(worktree, await readGit(worktree, "rev-parse", "--git-path", name)))) return result("skipped", `Not brought up to date with main ${after}: the card worktree is in the middle of a Git operation (${name})`);
    const prMode = this.board.integrationFor(card.repo) === "github-pr";
    const mainName = prMode ? "origin/main" : "main";
    const main = await readGit(repo, "rev-parse", "--verify", prMode ? "refs/remotes/origin/main" : "refs/heads/main");
    const head = await readGit(worktree, "rev-parse", "HEAD");
    if (await isAncestorAsync(worktree, main, head)) return result("current", "");
    const temp = mkdtempSync(join(tmpdir(), "alice-dependent-"));
    try {
      // The worktree as it stands, uncommitted and untracked files included, as a tree. See `snapshot`.
      const index = join(temp, "index");
      try { copyFileSync(resolve(worktree, await readGit(worktree, "rev-parse", "--git-path", "index")), index); }
      catch { await gitCommandAsync(worktree, ["read-tree", "HEAD"], false, index); }
      await gitCommandAsync(worktree, ["add", "-A"], false, index);
      const work = await gitCommandAsync(worktree, ["write-tree"], false, index);
      // What is staged, from a copy of the real index so it is only read. Usually the same as HEAD.
      const stagedIndex = join(temp, "staged");
      copyFileSync(resolve(worktree, await readGit(worktree, "rev-parse", "--git-path", "index")), stagedIndex);
      const staged = await gitCommandAsync(worktree, ["write-tree"], false, stagedIndex);
      const headTree = await readGit(worktree, "rev-parse", `${head}^{tree}`);
      const conflict = (files: string[], what = "conflicts in") => {
        const details = `Bringing the card up to date with ${mainName} (${main.slice(0, 12)}) ${after} ${what} ${files.join(", ")}. Alice changed nothing in the card worktree.`;
        this.board.recordMergeFailure(card.id, files, details);
        return result("conflict", `${details} Choose Fix conflict with Pi, or resolve it yourself`);
      };
      // The branch's own commits with main: a fast-forward when it has none.
      const ownCommits = !await isAncestorAsync(worktree, head, main);
      const branch = ownCommits ? await mergeTreeAsync(worktree, [head, main]) : { tree: await readGit(worktree, "rev-parse", `${main}^{tree}`), conflicts: [] };
      if (branch.conflicts.length) return conflict(branch.conflicts);
      const merged = await mergeTreeAsync(worktree, [`--merge-base=${head}`, branch.tree, work]);
      if (merged.conflicts.length) return conflict(merged.conflicts);
      const stagedMerge = staged === headTree ? { tree: branch.tree, conflicts: [] } : await mergeTreeAsync(worktree, [`--merge-base=${head}`, branch.tree, staged]);
      if (stagedMerge.conflicts.length) return conflict(stagedMerge.conflicts, "conflicts with changes staged in");
      const collisions = await ignoredCollisions(worktree, work, merged.tree);
      if (collisions.length) return conflict(collisions, "would overwrite local files Git ignores:");
      // From here on nothing awaits, so no request can approve or start the card halfway through.
      const current = this.board.getCard(card.id);
      if (current?.status !== "review" || this.board.listRuns(card.id)[0]?.id !== run.id) return result("skipped", `Not brought up to date with main ${after}: the card changed while Alice was checking it`);
      if (busy()) return defer();
      const cardRef = cardBranch(repo, card.id), ref = `refs/heads/${cardRef}`;
      const newHead = ownCommits
        ? git(worktree, ...commitIdentityArgs(worktree), "commit-tree", branch.tree, "-p", head, "-p", main, "-m", `Merge ${mainName} into ${cardRef}`, "-m", `${parent.title} (${parent.id}) merged; Alice brought this card up to date.`)
        : main;
      git(worktree, "update-ref", "-m", `alice: update onto ${mainName} ${after}`, ref, newHead, head);
      try { gitCommand(worktree, ["read-tree", "-m", "-u", work, merged.tree], index); }
      catch (error) {
        git(worktree, "update-ref", ref, head, newHead);
        throw error;
      }
      // The branch moved under the real index. Point it at the new commit, so the card's work stays unstaged as before,
      // or at the merged staged changes when some were staged. A refresh after `read-tree` only updates file stats.
      if (staged === headTree) git(worktree, "reset", "-q");
      else {
        git(worktree, "read-tree", stagedMerge.tree);
        try { git(worktree, "update-index", "-q", "--refresh"); } catch { /* Exit 1 only lists files that differ from the index. */ }
      }
      this.board.clearMergeFailure(card.id);
      const requeued = this.board.requeueAutoReview(card.id, run.id);
      return result("updated", `Brought up to date with ${mainName} (${main.slice(0, 12)}) ${after}${ownCommits ? ", with a merge commit on the card branch" : ""}.${requeued ? " Agent review runs again on the result." : " Refresh the diff to review it against the new main."}`);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }

  withdraw(card: Card): Card {
    const approval = this.board.getApproval(card.id);
    if (card.status !== "review" || !approval) throw new Error("No pending approval to withdraw");
    if (approval.preparedHead && isAncestor(card.repo, approval.preparedHead, "main")) throw new Error("This approval reached main; inspect it before withdrawing");
    this.board.cancelApproval(card.id, approval.runId, true);
    return this.board.getCard(card.id)!;
  }

  /**
   * Approve on a github-pr board: commit the reviewed work on `alice/<id>`, push that branch to origin, and open
   * a PR (or reuse the open one). Nothing merges locally; the card stays in Review until the PR merges on GitHub.
   * The operator's Approve (or, with auto-review on, the agent reviewer's approval) authorizes the push; the
   * implementing agent itself never pushes.
   * `draft` is the title and body the operator approved; without it the card title and body are used. A new PR's
   * title must pass the repository's semantic-PR check, when it has one, before anything is pushed.
   * `pushedBy` says who authorized the push, for the PR comment: the operator's Approve, an automatic CI fix, or
   * the agent reviewer's approval on a board with auto-review on. Only "operator" means a person reviewed it.
   * `prechecked` waits for the hook check that started when the run reached Review (see `checkHooks`) and returns
   * the commit whose pre-push hook passed, or null; pushing exactly that commit skips the hook.
   * `handoff` is the agent reviewer's findings when it left the card for a person: a new PR then opens as a draft and
   * the findings are posted on it.
   */
  async openPullRequest(card: Card, reviewedFingerprint: string, github: GitHub, draft?: { title: string; body: string }, pushedBy: "operator" | "ci-fix" | "agent-review" | "auto-pull-request" = "operator", prechecked?: () => Promise<string | null>, handoff?: string): Promise<Card> {
    const repoBoard = this.board.boardForRepo(card.repo);
    if (repoBoard?.integrationConfigured === "github-pr" && !this.board.features.pullRequests) throw new Error(featureOffMessage("pullRequests"));
    if (repoBoard?.integration !== "github-pr") throw new Error("This board merges locally; use Approve and merge into local main");
    if (card.prOverrideUrl) throw new Error(`This card is linked to ${card.prOverrideUrl}. Alice only pushes ${cardBranch(card.repo, card.id)}; update that pull request yourself, or clear the link`);
    const slug = boardGithubRepo(repoBoard);
    return this.trackPush(card.id, async (step, push) => {
      step("Checking GitHub access");
      await github.check();
      let passed: string | null = null;
      if (prechecked) {
        step("Waiting for the hook check that started when the run reached Review");
        passed = await prechecked();
      }
      const { repo, worktree, run } = this.location(card);
      if (this.board.hasRequestedChanges(card.id, run.id)) throw new Error("Changes requested; review a new attempt before approving");
      if (this.board.hasDraftReviewComments(card.id, run.id)) throw new Error("Submit or remove draft review comments before approving");
      const inspected = this.snapshot(card, false);
      if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before approving");
      const branch = cardBranch(repo, card.id);
      // An open PR keeps its title and body; only a new one must pass the repository's title check.
      const existing = await github.findByBranch(slug, branch);
      const hasOpenPr = existing?.state === "OPEN";
      const title = draft ? draft.title.replace(/\s+/g, " ").trim().slice(0, 250) : cardTitle(card);
      const semantic = readPullRequestRules(worktree).semantic;
      const problem = !hasOpenPr && semantic ? semanticTitleProblem(title, semantic) : "";
      if (problem) throw new Error(`Pull request title "${title}" would fail ${semantic!.source}: ${problem}. Edit the title in the Approve dialog`);
      if (draft && !title) throw new Error("Pull request title is required");
      step("Committing the reviewed work");
      const candidate = this.commitReviewed(card, worktree, inspected.tree);
      step("Fetching origin");
      await fetchOrigin(repo);
      if (!git(repo, "rev-list", "refs/remotes/origin/main.." + candidate)) throw new Error("This card has no commits that are not already on origin/main");
      const state = remoteBranchState(repo, branch, candidate, null);
      if (state === "diverged") {
        step(`Merging origin/${branch} into the card worktree`);
        const { merged, head } = mergeRemoteBranch(worktree, branch);
        throw new Error(`Merged ${merged} commit${merged === 1 ? "" : "s"} from origin/${branch} into the card worktree (now ${head.slice(0, 12)}), keeping the card's own commits. Nothing was pushed. The merged result is new work, so refresh the diff: verification and review run on it again before it is pushed`);
      }
      if (state === "on-origin") {
        // Origin is ahead with nothing of ours missing: catch the worktree up so the next attempt builds on it.
        step(`Fast-forwarding the card worktree to origin/${branch}`);
        git(worktree, "merge", "--ff-only", "--quiet", `refs/remotes/origin/${branch}`);
      } else {
        const checked = passed === candidate;
        step(checked ? `Pushing ${branch} (its pre-push hook already passed when the run reached Review)` : `Pushing ${branch} (the repository's pre-push hooks run first)`);
        // A plain push: if the branch on GitHub moved after the fetch, Git still refuses instead of overwriting it.
        try { await push(worktree, `${candidate}:refs/heads/${branch}`, checked ? ["--no-verify"] : []); }
        catch (error) {
          if (error instanceof PushError && error.hookFailed) throw new PushHookError(error, candidate);
          // Origin's branch moved between the fetch and the push. Git refused rather than overwrite it; do not retry.
          if (error instanceof PushError && /! \[(remote )?rejected\]|non-fast-forward|fetch first/.test(error.output))
            throw new Error(`${branch} on origin changed while Alice was pushing, so Git refused the push and nothing was overwritten. Approve again to merge the new commits into the card worktree\n\n${error.message}`);
          throw error;
        }
      }
      step(hasOpenPr ? "Updating the pull request" : "Opening the pull request");
      const why = { "operator": "changes the operator reviewed and approved in Alice", "ci-fix": "a fix for the failing CI, pushed automatically without human review", "agent-review": "changes Alice's agent reviewer approved, pushed automatically without human review", "auto-pull-request": "changes pushed automatically when the run reached Review, without human review" }[pushedBy];
      const pushed = state === "push" ? { sha: candidate, why } : null;
      const pr = await this.ensurePullRequest(card, run.output, slug, github, pushed, { title, body: draft ? draft.body : card.body }, handoff);
      // A failed findings comment is kept and retried by the GitHub sync rather than lost.
      if (handoff && !pr.handoffPosted) this.board.setHandoffPending(run.id, true);
      // Explicit approval is the person's decision on a handoff draft: it becomes ready for review.
      if (pushedBy === "operator" && this.board.autoReviewHandoff(run.id) !== null) {
        await github.ready(slug, pr.number);
        this.board.resolveHandoff(run.id);
      }
      this.board.recordPullRequest(card.id, { number: pr.number, url: pr.url, state: "OPEN" });
      this.board.recordPullRequestPush(card.id, run.id);
      return this.board.getCard(card.id)!;
    });
  }

  /**
   * Gets a github-pr card ready for Approve when its run reaches Review: commits the work on `alice/<id>` as Approve
   * would (the repository's pre-commit and commit-msg hooks run), then runs the pre-push hook on that commit with
   * `git push --dry-run`, so nothing reaches origin. A refused commit throws `CommitHookError` and a refused pre-push
   * hook `PushHookError`. "unchecked" means Git
   * stopped the dry run for another reason (origin's branch moved, no network), so Approve runs the hook as before.
   * A hook that rewrites files (a formatter) changes the diff under review, which then shows its changes.
   */
  async checkHooks(card: Card, signal: AbortSignal, step: (text: string) => void): Promise<{ candidate: string; state: "passed" | "unchecked"; detail: string }> {
    const { worktree } = this.location(card);
    await gitAsync(worktree, ["add", "-A"], signal);
    if (await gitAsync(worktree, ["diff", "--cached", "--name-only"], signal)) {
      await gitAsync(worktree, ["diff", "--cached", "--check"], signal);
      step("Committing the card's work (the repository's pre-commit hooks run)");
      try { await gitAsync(worktree, [...commitIdentityArgs(worktree), "commit", "-m", `Alice card: ${card.title.slice(0, 70)}`], signal); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Identity and message are always set, so a failed commit here is the repository's commit hooks refusing it.
        if (signal.aborted || !message.startsWith("commit failed: ")) throw error;
        throw new CommitHookError(message, message.slice("commit failed: ".length));
      }
    }
    if (!clean(worktree)) throw new Error("The card worktree has uncommitted changes after Alice committed it; a hook may have changed files");
    const candidate = git(worktree, "rev-parse", "HEAD");
    step("Running the pre-push hook on that commit (git push --dry-run, nothing is pushed)");
    try { await pushBranch(worktree, `${candidate}:refs/heads/${cardBranch(worktree, card.id)}`, () => {}, { flags: ["--dry-run"], signal }); }
    catch (error) {
      if (error instanceof PushError && error.hookFailed) throw new PushHookError(error, candidate);
      if (error instanceof PushError) return { candidate, state: "unchecked", detail: error.message };
      throw error;
    }
    return { candidate, state: "passed", detail: "" };
  }

  /**
   * The open PR from `alice/<id>`, or a new one with `content` (default: the card title and body) plus the footer and
   * run summary. `pushed` is what Alice just pushed, commented on an open PR; null when nothing was pushed.
   */
  private async ensurePullRequest(card: Card, output: string, slug: string, github: GitHub, pushed: { sha: string; why: string } | null, content?: { title: string; body: string }, handoff?: string): Promise<{ number: number; url: string; handoffPosted: boolean }> {
    const branch = cardBranch(card.repo, card.id);
    const existing = await github.findByBranch(slug, branch);
    let url = existing?.state === "OPEN" ? existing.url : "";
    const summary = (output || "").trim().slice(-3000);
    const details = summary ? `\n\n<details><summary>Run summary</summary>\n\n${summary}\n\n</details>` : "";
    if (existing && url && pushed) await commentOnPullRequest(github, slug, existing.number, `Alice pushed ${pushed.sha.slice(0, 12)}: ${pushed.why}.${details}`);
    let handoffPosted = true;
    if (!url) {
      // The findings go in the body so they exist the moment the draft does; a separate comment could fail and never be retried.
      const body = pullRequestBody(content?.body ?? card.body, card, { output });
      url = await github.create(slug, branch, content?.title ?? cardTitle(card), handoff ? `${body}\n\n---\n\n${githubMarkdown(handoff)}` : body, !!handoff);
      this.delivered("pr", undefined);
    } else if (handoff && existing?.state === "OPEN") {
      // An existing pull request gets the findings as a comment; if it fails, the caller records it as pending.
      try { await postPullRequestComment(github, slug, existing.number, handoff); }
      catch (error) { console.error(`Could not post the reviewer's findings on ${slug}#${existing.number}: ${error instanceof Error ? error.message : String(error)}`); handoffPosted = false; }
    }
    return { number: Number(url.match(/\/pull\/(\d+)/)?.[1]), url, handoffPosted };
  }

  /**
   * Done cards Alice merged into local main whose approved candidate is not on origin/main, after a fetch, and
   * whether local main can be reset to origin/main. Works on a local board too, so switching to github-pr can list them.
   */
  async localMerges(repo: string): Promise<{ cards: LocalMerge[]; main: MainRecovery | null }> {
    await fetchOrigin(repo);
    const cards: LocalMerge[] = [];
    for (const { card, candidate } of this.board.listLocalMerges(repo)) {
      if (hasCommit(repo, candidate) && isAncestor(repo, candidate, "refs/remotes/origin/main")) continue;
      cards.push({ card, candidate, commits: hasCommit(repo, candidate) ? Number(git(repo, "rev-list", "--count", `refs/remotes/origin/main..${candidate}`)) : 0, blocker: publishBlocker(repo, card, candidate) });
    }
    return { cards, main: this.mainRecovery(repo) };
  }

  /**
   * "Publish as PR" for a Done card that Alice merged into local main on a github-pr board: push the approved
   * candidate to `alice/<id>`, open its PR (or reuse the open one) as Approve does, then clear the local integration
   * record and move the card back to Review, so it reaches Done when the PR merges. Local main is not touched here;
   * the result says whether it can be reset, which needs a separate confirmation.
   */
  async publishLocalMerge(card: Card, github: GitHub): Promise<{ card: Card; main: MainRecovery | null }> {
    const repoBoard = this.board.boardForRepo(card.repo);
    if (!this.board.features.pullRequests) throw new Error(featureOffMessage("pullRequests"));
    if (repoBoard?.integration !== "github-pr") throw new Error("Switch this board to GitHub pull requests before publishing a card as a pull request");
    if (card.status !== "done") throw new Error("Only a Done card that was merged into local main can be published as a pull request");
    if (card.prOverrideUrl) throw new Error(`This card is linked to ${card.prOverrideUrl}. Alice only pushes ${cardBranch(card.repo, card.id)}; clear the link first`);
    const slug = boardGithubRepo(repoBoard);
    return this.trackPush(card.id, async (step, push) => {
      step("Checking GitHub access");
      await github.check();
      const repo = card.repo;
      step("Fetching origin");
      await fetchOrigin(repo);
      const merge = this.board.listLocalMerges(repo).find(item => item.card.id === card.id);
      if (!merge) throw new Error("This card was not merged into local main by Alice; there is nothing to publish");
      const { candidate } = merge;
      const blocker = publishBlocker(repo, card, candidate);
      if (blocker) throw new Error(blocker);
      if (isAncestor(repo, candidate, "refs/remotes/origin/main")) throw new Error("This card's approved work is already on origin/main; there is nothing to publish");
      const branch = cardBranch(repo, card.id);
      const state = remoteBranchState(repo, branch, candidate, null);
      let toPush = candidate;
      let merged = 0;
      if (state === "diverged") {
        // No card worktree to merge into: merge in a scratch worktree, then push the result as a plain fast-forward.
        step(`Merging origin/${branch} into the approved commit`);
        const scratch = mkdtempSync(join(tmpdir(), "alice-publish-merge-"));
        try {
          git(repo, "worktree", "add", "--detach", scratch, candidate);
          ({ merged, head: toPush } = mergeRemoteBranch(scratch, branch, true));
          step(`Pushing ${branch} (the repository's pre-push hooks run first)`);
          try { await push(scratch, `${toPush}:refs/heads/${branch}`); }
          catch (error) {
            if (error instanceof PushError && !error.hookFailed && /! \[(remote )?rejected\]|non-fast-forward|fetch first/.test(error.output))
              throw new Error(`${branch} on origin changed while Alice was pushing, so Git refused the push and nothing was overwritten. Publish again to merge the new commits`);
            throw error;
          }
        } finally {
          try { git(repo, "worktree", "remove", "--force", scratch); } catch { rmSync(scratch, { recursive: true, force: true }); }
        }
      } else if (state === "push") {
        step(`Pushing ${branch} (the repository's pre-push hooks run first)`);
        // A plain push: if alice/<id> on GitHub moved after the fetch, Git still refuses instead of overwriting it.
        await push(repo, `${candidate}:refs/heads/${branch}`);
      }
      step("Opening the pull request");
      const pr = await this.ensurePullRequest(card, this.board.listRuns(card.id)[0]?.output ?? "", slug, github, state === "on-origin" ? null : { sha: toPush, why: merged ? `work the operator approved in Alice and merged into local main earlier, merged with ${merged} commit${merged === 1 ? "" : "s"} already on the branch, now published as a pull request` : "work the operator approved in Alice and merged into local main earlier, now published as a pull request" });
      return { card: this.board.recordPublishedLocalMerge(card.id, candidate, pr), main: this.mainRecovery(repo) };
    });
  }

  /**
   * Whether local main can go back to origin/main without losing anything: it is checked out with no uncommitted
   * tracked changes, and every local commit on its first-parent line is an Alice card merge whose card branch is
   * on origin. Null when local main has no commits that origin/main lacks.
   */
  mainRecovery(repo: string): MainRecovery | null {
    let head = "";
    try { head = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* Detached HEAD. */ }
    if (!hasCommit(repo, "refs/remotes/origin/main") || !hasCommit(repo, "refs/heads/main")) return null;
    const tip = git(repo, "rev-parse", "refs/heads/main"), originMain = git(repo, "rev-parse", "refs/remotes/origin/main");
    const local = git(repo, "rev-list", "--first-parent", `${originMain}..${tip}`).split("\n").filter(Boolean);
    if (!local.length) return null;
    const recovery = { tip, originMain, recoveryBranch: `alice-recovery/${tip.slice(0, 12)}`, localCommits: local.length };
    const refuse = (reason: string): MainRecovery => ({ ...recovery, resettable: false, reason });
    if (head !== "main") return refuse(`The repository root is ${head ? `on branch ${head}` : "in detached HEAD"}, not main`);
    const dirty = git(repo, "status", "--porcelain", "--untracked-files=no");
    if (dirty) return refuse("Local main has uncommitted changes");
    for (const commit of local) {
      const [, ...parents] = git(repo, "rev-list", "--parents", "-n", "1", commit).split(" ");
      const id = git(repo, "log", "-1", "--format=%B", commit).match(/^Card: ([\w-]+)$/m)?.[1];
      const subject = git(repo, "log", "-1", "--format=%s", commit);
      if (parents.length < 2 || !id || !subject.startsWith("Merge card: ")) return refuse(`Local main has commit ${commit.slice(0, 12)} (${subject}) that is not an Alice card merge`);
      const card = this.board.getCard(id);
      if (card?.locallyMerged) return refuse(`${card.title} (${id}) is still merged only into local main; publish it as a pull request first`);
      const onOrigin = (ref: string) => hasCommit(repo, ref) && parents.slice(1).every(parent => isAncestor(repo, parent, ref));
      if (!cardBranches(id).some(branch => onOrigin(`refs/remotes/origin/${branch}`)) && !onOrigin("refs/remotes/origin/main")) return refuse(`Card ${id}'s merged work is not on origin yet; publish it as a pull request first`);
    }
    return { ...recovery, resettable: true, reason: "" };
  }

  /**
   * Resets local main to origin/main after saving its tip as `alice-recovery/<sha>`. Only on the operator's
   * confirmation of the exact tip they saw, and only while `mainRecovery` still allows it. `reset --keep`
   * refuses instead of overwriting untracked files.
   */
  async resetLocalMain(repo: string, confirmedTip: string): Promise<MainRecovery | null> {
    await fetchOrigin(repo);
    const recovery = this.mainRecovery(repo);
    if (!recovery) throw new Error("Local main has no commits that origin/main lacks; nothing to reset");
    if (recovery.tip !== confirmedTip) throw new Error("Local main moved since you confirmed; review it again before resetting");
    if (!recovery.resettable) throw new Error(recovery.reason);
    const branch = `refs/heads/${recovery.recoveryBranch}`;
    if (hasCommit(repo, branch)) {
      if (git(repo, "rev-parse", branch) !== recovery.tip) throw new Error(`${recovery.recoveryBranch} already exists at another commit`);
    } else git(repo, "branch", recovery.recoveryBranch, recovery.tip);
    git(repo, "reset", "--keep", recovery.originMain);
    return this.mainRecovery(repo);
  }

  /** Commits the reviewed worktree on the card branch, if it has uncommitted changes, and returns the commit. */
  private commitReviewed(card: Card, worktree: string, reviewedTree: string): string {
    git(worktree, "add", "-A");
    if (git(worktree, "write-tree") !== reviewedTree) throw new Error("Worktree changed since review; refresh the diff before approving");
    if (git(worktree, "diff", "--cached", "--name-only")) {
      git(worktree, "diff", "--cached", "--check");
      git(worktree, ...commitIdentityArgs(worktree), "commit", "-m", `Alice card: ${card.title.slice(0, 70)}`);
    }
    if (!clean(worktree)) throw new Error("Card worktree changed while committing; inspect it and retry");
    const candidate = git(worktree, "rev-parse", "HEAD");
    if (git(worktree, "rev-parse", "HEAD^{tree}") !== reviewedTree) throw new Error("Committed work changed since review; refresh the diff before approving");
    return candidate;
  }

  /**
   * When the repository has an `origin`, fetch it and refuse to merge into a main that is behind origin/main, so a
   * card never lands on a stale main. Ahead is fine (local work not yet pushed). A failed fetch only warns.
   * Behind main is brought level when that is safe (clean checkout, no rebase conflict). The review diff and its
   * fingerprint were taken against the old main, so the operator still refreshes and approves again.
   */
  private requireMainCurrent(repo: string) {
    if (!hasOrigin(repo)) return;
    const warning = fetchOriginBestEffort(repo, this.fetchTimeoutMs);
    if (warning) { this.warnings.push(warning); this.warnings.splice(0, this.warnings.length - 20); console.warn(`${repo}: ${warning}`); }
    const state = compareWithOriginMain(repo);
    if (!state) return;
    const synced = syncMainWithOrigin(repo, state);
    if (synced) throw new Error(`${synced}. Refresh the diff and approve again`);
    const blocked = behindOriginMessage(repo, state);
    if (blocked) throw new Error(blocked);
  }

  /** A research run answers in its final message and leaves no diff; accepting it closes the card without Git. */
  acceptFindings(card: Card, reviewedFingerprint: string): Card {
    const { run } = this.location(card);
    if (this.board.getAutoReviewJob(run.id)?.state === "running") throw new Error("Agent review is in progress; wait for its result");
    const inspected = this.snapshot(card, true);
    if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before accepting");
    if (inspected.files.length) throw new Error("This run changed files; approve or request changes instead");
    return this.board.acceptFindings(card.id, run.id);
  }

  /** Marks the card Done, then pushes main when the board asks for it. A failed push never undoes the merge; it goes in the card's history. */
  private delivered<T>(kind: "merge" | "pr", value: T): T {
    try { this.onDelivered(kind); } catch { /* telemetry never affects a merge */ }
    return value;
  }
  private completeAndPush(card: Card, runId: string, candidate: string, repo: string): Card {
    const done = this.board.completeApproval(card.id, runId, candidate);
    this.afterMerge(card.id);
    if (!this.board.boardForRepo(card.repo)?.pushMainAfterMerge) return done;
    try {
      execFileSync("git", ["-C", repo, "push", "origin", "main"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      this.board.noteCard(card.id, "Pushed main to origin after the merge");
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
      this.board.noteCard(card.id, `Merged into local main, but pushing main to origin failed: ${detail.slice(0, 500)}. Push it yourself.`);
    }
    return done;
  }
  approve(card: Card, reviewedFingerprint: string): Card {
    if (this.board.integrationFor(card.repo) === "github-pr") throw new Error("This board integrates through GitHub pull requests; Approve opens a pull request instead of merging locally");
    const repoBoard = this.board.boardForRepo(card.repo);
    // Pull requests are off in this build, so a board set to them has no safe way to deliver: never merge locally in their place.
    if (repoBoard?.integrationConfigured === "github-pr")
      throw new Error(`This board is set to GitHub pull requests, which are turned off in this build, so Approve will not merge into local main instead. ${featureOffMessage("pullRequests")} Or choose Local merge in the board's settings to merge locally.`);
    if (repoBoard?.githubMainProtected && !repoBoard.integrationChosen && !this.board.features.pullRequests)
      throw new Error(`main on ${githubRepo(repoBoard.remoteUrl) ?? repoBoard.remoteUrl} only accepts pull requests, and pull requests are turned off in this build, so merging into local main would leave it ahead of GitHub. ${featureOffMessage("pullRequests")} Or choose Local merge in the board's settings to merge locally anyway.`);
    if (repoBoard?.githubMainProtected && !repoBoard.integrationChosen)
      throw new Error(`main on ${githubRepo(repoBoard.remoteUrl) ?? repoBoard.remoteUrl} only accepts pull requests, so merging into local main would leave it ahead of GitHub. Switch Integration to GitHub pull requests in the board's settings, or choose Local merge there to merge locally anyway`);
    const { repo, worktree, run } = this.location(card);
    const job = this.board.getAutoReviewJob(run.id);
    if (job?.state === "running") throw new Error("Agent review is in progress; wait for its result");
    if (this.board.hasRequestedChanges(card.id, run.id)) throw new Error("Changes requested; review a new attempt before approving");
    if (this.board.hasDraftReviewComments(card.id, run.id)) throw new Error("Submit or remove draft review comments before approving");
    if (git(repo, "symbolic-ref", "--short", "HEAD") !== "main") throw new Error("Check out main at the repository root before approving");
    const pending = this.board.getApproval(card.id);
    if (!(pending?.preparedHead && isAncestor(repo, pending.preparedHead, "main"))) this.requireMainCurrent(repo);
    const localStatus = gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true);
    const blocked = this.localConflicts(card);
    if (blocked.length) throw new Error(`Uncommitted changes on main would be overwritten: ${blocked.slice(0, 10).join(", ")}${blocked.length > 10 ? ", …" : ""}. Commit or stash them at ${repo}, then approve again`);
    const inspected = this.snapshot(card, false);
    if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before approving");

    let approved = this.board.getApproval(card.id);
    if (approved) {
      if (approved.runId !== run.id || git(worktree, "rev-parse", "HEAD") !== approved.candidate || !clean(worktree)) throw new Error("Card worktree changed after approval; inspect it before retrying");
    } else {
      const candidate = this.commitReviewed(card, worktree, inspected.tree);
      // A card must contribute a commit, not merely close an unchanged run.
      if (!git(repo, "rev-list", "main.." + candidate)) throw new Error("This card has no unmerged commits to approve");
      approved = this.board.recordApproval(card.id, run.id, candidate);
    }

    if (approved.preparedHead && isAncestor(repo, approved.preparedHead, "main")) {
      if (git(repo, "rev-parse", "main") !== approved.preparedHead) throw new Error("Main changed after Alice merged this card; inspect the result before closing it");
      return this.delivered("merge", this.completeAndPush(card, run.id, approved.candidate, repo));
    }
    if (isAncestor(repo, approved.candidate, "main")) throw new Error("Card branch was merged outside Alice; inspect main before closing this card");
    const base = git(repo, "rev-parse", "main");
    if (base !== inspected.main) throw new Error("Main changed since review; refresh the diff before approving");
    const directory = join(this.dataDir, "integrations");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(directory, `${card.id}-`));
    try {
      git(repo, "worktree", "add", "--detach", scratch, base);
      try {
        git(scratch, ...commitIdentityArgs(scratch), "merge", "--no-ff", "--no-edit", ...mergeMessage(card, cardBranch(repo, card.id)), approved.candidate);
      } catch (error) {
        // No integration was published. Read the scratch index before removing it so the UI can name the conflicts.
        let files: string[] = [];
        try { files = [...new Set(git(scratch, "ls-files", "-u", "-z").split("\0").filter(Boolean).map(entry => entry.slice(entry.indexOf("\t") + 1)))]; }
        catch { /* Keep the original Git failure if the scratch index cannot be read. */ }
        this.board.cancelApproval(card.id, run.id);
        if (files.length) {
          const details = error instanceof Error ? error.message : String(error);
          this.board.recordMergeFailure(card.id, files, details);
          throw new IntegrationConflictError(card.id, files, details);
        }
        throw error;
      }
      const merged = git(scratch, "rev-parse", "HEAD");
      git(repo, "diff", "--check", base, merged);
      if (git(repo, "rev-parse", "main") !== base || gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true) !== localStatus) throw new Error("Main or its local changes changed during approval; retry before merging");
      this.board.recordPreparedMerge(card.id, run.id, approved.candidate, merged);
      git(repo, "merge", "--no-overwrite-ignore", "--ff-only", merged);
      // Git refuses to overwrite local changes; unrelated edits may remain after the fast-forward.
      return this.delivered("merge", this.completeAndPush(card, run.id, approved.candidate, repo));
    } finally {
      // Only remove Alice's temporary integration checkout. Keep the card worktree on every failure.
      try { git(repo, "worktree", "remove", "--force", scratch); } catch { /* Keep the original error; the scratch path is recoverable. */ }
    }
  }
}
