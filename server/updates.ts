import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { git } from "./git-async.js";

// Updates for a hosted Alice checkout. A timer fetches origin/main (scripts/update.sh); this lists what the fetch
// brought in, plus anything merged into the checked-out main since the server started (approving a card merges it
// locally), so the UI can show a changelog. It installs only on request.
// An update that touches only the browser UI swaps the new build in at once. Anything the server process runs (its
// own files, the src modules it imports, dependencies, scripts) needs a restart, which the caller does after
// draining active runs.

export type UpdateCommit = { sha: string; subject: string };
/**
 * `restart`: whether installing the pending commits restarts the server (and so waits for active runs).
 * `ui`: the commit the served UI was built from; it changes when a UI-only update is swapped in, so open pages reload.
 */
export type UpdateState = { commits: UpdateCommit[]; installing: boolean; error: string | null; restart: boolean; ui: string | null };
type Install = () => Promise<void>;

/** Runs `scripts/update.sh install` (fast-forward, npm install, UI build into dist-next) in `root`. */
export const installScript = (root: string): Install => () => new Promise((done, fail) => {
  execFile("bash", ["scripts/update.sh", "install"], { cwd: root, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
    if (!error) return done();
    const detail = stderr.trim().split("\n").slice(-5).join("\n") || error.message;
    fail(new Error(detail));
  });
});

export class Updates {
  private commits: UpdateCommit[] = [];
  private installing = false;
  private error: string | null = null;
  private restart = false;
  // The commit the server process started on: its code. Changes since then decide whether an install restarts.
  private serverHead: string | null;
  // The commit the installed code is at: serverHead, or later after UI-only installs. Local merges move HEAD past it.
  private installedHead: string | null;
  // Files the running server loads, read once at startup.
  private serverFiles: Set<string>;
  // The pending target whose automatic UI install failed, so the timer does not rebuild it every tick.
  private failedTarget: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private root: string,
    private install: Install,
    private onInstalled: () => void,
    private onUiInstalled: () => void = () => promoteStagedUi(root, { keepOldAssets: true }),
  ) {
    // Once at startup, before the server listens, so synchronous Git blocks no request.
    try { this.serverHead = this.installedHead = execFileSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null; }
    catch { this.serverHead = this.installedHead = null; }
    this.serverFiles = serverModules(root);
  }

  get state(): UpdateState {
    return { commits: this.commits, installing: this.installing, error: this.error, restart: this.restart, ui: this.installedHead };
  }

  /**
   * Re-reads the pending commits: those on origin/main that the checked-out main lacks, and those merged into main
   * since the server started. Only `main` checkouts update. Calls that overlap one in progress share it.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.reread().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async reread(): Promise<void> {
    try {
      if (await this.git("rev-parse", "--abbrev-ref", "HEAD") !== "main") { this.commits = []; this.restart = false; return; }
      // Newest first: what origin/main would bring in, then what was merged locally since startup. Merge commits are
      // left out: approving a card adds a "Merge card:" commit on top of the card's own, which would list it twice.
      const originMain = await this.originMain();
      const ranges = [originMain && "HEAD..refs/remotes/origin/main", this.installedHead && `${this.installedHead}..HEAD`];
      const logs = await Promise.all(ranges.filter((range): range is string => !!range).map(range => this.git("log", "--no-merges", "--format=%h%x09%s", range)));
      const log = logs.filter(Boolean).join("\n");
      // A reworked card lands one commit per attempt under the same subject; list it once, under the newest.
      const seen = new Set<string>();
      this.commits = (log ? log.split("\n") : []).flatMap(line => {
        const [sha, ...rest] = line.split("\t");
        const subject = rest.join("\t");
        if (seen.has(subject)) return [];
        seen.add(subject);
        return [{ sha, subject }];
      });
      const targets = [originMain && "refs/remotes/origin/main", "HEAD"].filter((ref): ref is string => !!ref);
      let restart = false;
      if (this.commits.length > 0) for (const target of targets) if (await this.needsRestart(target)) { restart = true; break; }
      this.restart = restart;
    } catch (error) {
      this.commits = [];
      this.restart = false;
      console.warn(`Update check failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * The update timer's tick: re-reads what is pending and installs it straight away when it is UI-only. Updates that
   * need a restart wait for someone to ask, since they pause new runs. A failed automatic install is not retried
   * until something new lands.
   */
  async poll(): Promise<void> {
    if (this.installing) return;
    await this.refresh();
    if (this.commits.length === 0 || this.restart) return;
    if (await this.target() === this.failedTarget) return;
    // This tick awaited Git above, so `begin` reads again: a manual install may have landed, or a server change
    // arrived, which waits for the button like any other.
    const started = await this.begin(true);
    if (!started) return;
    await started.done;
    // Read after the attempt: a fast-forward can land before the build fails.
    if (this.error) this.failedTarget = await this.target();
  }

  /**
   * Installs pending commits. A UI-only install swaps the new build in and is done; otherwise `onInstalled` drains
   * and restarts. Rejects when nothing is pending.
   */
  async apply(): Promise<void> {
    await (await this.begin()).done;
  }

  /**
   * Starts an install and resolves once it has started, with `done` for its end. Rejects when nothing is pending,
   * so the API can answer 400 without waiting for the install.
   */
  async begin(): Promise<{ done: Promise<void> }>;
  /**
   * `automatic`, for the timer: installs only a UI-only update, judged on what the final read finds, and resolves to
   * null when there is nothing it may install.
   */
  async begin(automatic: true): Promise<{ done: Promise<void> } | null>;
  async begin(automatic = false): Promise<{ done: Promise<void> } | null> {
    if (this.installing) return { done: Promise.resolve() };
    await this.refresh();
    if (this.installing) return { done: Promise.resolve() };
    if (automatic && (this.commits.length === 0 || this.restart)) return null;
    if (this.commits.length === 0) throw new Error("Already up to date");
    this.installing = true;
    this.error = null;
    return { done: this.run() };
  }

  private async run(): Promise<void> {
    try {
      await this.install();
    } catch (error) {
      this.installing = false;
      this.error = error instanceof Error ? error.message : String(error);
      console.error(`Update failed: ${this.error}`);
      return;
    }
    const count = `${this.commits.length} commit${this.commits.length === 1 ? "" : "s"}`;
    // Decide on what actually landed, not on what refresh() saw before the install.
    if (await this.needsRestart("HEAD")) {
      console.log(`Installed update (${count}); restarting once active runs finish.`);
      this.onInstalled();
      return;
    }
    try {
      this.onUiInstalled();
    } catch (error) {
      this.installing = false;
      this.error = error instanceof Error ? error.message : String(error);
      console.error(`UI update failed: ${this.error}`);
      return;
    }
    this.installedHead = await this.revParse("HEAD");
    this.installing = false;
    console.log(`Installed UI-only update (${count}); no restart needed.`);
    await this.refresh();
  }

  /** Whether moving from the running server's commit to `target` changes anything the server process loads. */
  private async needsRestart(target: string): Promise<boolean> {
    if (!this.serverHead) return true;
    const changed = (await this.git("diff", "--name-only", this.serverHead, target)).split("\n").filter(Boolean);
    return changed.some(path => !uiOnly(path, this.serverFiles));
  }

  /** What an install would land on: the fetched origin/main and the checked-out HEAD. */
  private async target(): Promise<string> { return `${await this.originMain() ?? ""}:${await this.revParse("HEAD") ?? ""}`; }

  private originMain(): Promise<string | null> { return this.revParse("refs/remotes/origin/main"); }

  private async revParse(ref: string): Promise<string | null> {
    try { return await this.git("rev-parse", "--verify", "-q", ref); } catch { return null; }
  }

  private git(...args: string[]): Promise<string> { return git(this.root, args); }
}

/**
 * Moves the UI that `scripts/update.sh install` built into `dist-next` over `dist`. The install builds there so the
 * draining server keeps serving the UI that matches its API; a new UI on the old server sends calls to routes the old
 * server lacks, which answer 404 until the restart. Call once at startup, holding the data directory lock.
 */
export function promoteStagedUi(root: string, { keepOldAssets = false } = {}): boolean {
  const staged = join(root, "dist-next");
  if (!existsSync(staged)) return false;
  const dist = join(root, "dist"), old = join(root, "dist-old");
  // Pages still open on the old UI lazy-load chunks by hashed name; a live swap keeps them so those pages still work
  // until they reload. Names are content hashes, so nothing in the new build is overwritten. A restart drops them.
  if (keepOldAssets && existsSync(join(dist, "assets"))) cpSync(join(dist, "assets"), join(staged, "assets"), { recursive: true, force: false });
  rmSync(old, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, old);
  renameSync(staged, dist);
  rmSync(old, { recursive: true, force: true });
  return true;
}

// Paths that never reach the server process: the browser UI and its build inputs, plus files nothing runs (tests,
// docs, the desktop and iOS shells). A src file is UI-only unless the server imports it.
const uiPaths = [/^src\//, /^public\//, /^assets\//, /^tests\//, /^docs\//, /^desktop\//, /^ios\//, /^src-tauri\//, /^index\.html$/, /^vite\.config\.ts$/, /^components\.json$/, /^[^/]+\.md$/];

export function uiOnly(path: string, serverFiles: Set<string>): boolean {
  return !serverFiles.has(path) && uiPaths.some(pattern => pattern.test(path));
}

/** Repo-relative paths of every module reachable from server/index.ts through relative imports. */
export function serverModules(root: string, entry = "server/index.ts"): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(root, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    // Forward slashes on every platform, matching the paths `git diff --name-only` reports.
    const path = relative(root, file).split(sep).join("/");
    if (seen.has(path) || !existsSync(file)) continue;
    seen.add(path);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = resolve(dirname(file), specifier);
      const stem = base.replace(/\.(js|mjs|cjs)$/, "");
      const found = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, "index.ts")].find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile());
      if (found) queue.push(found);
    }
  }
  return seen;
}
