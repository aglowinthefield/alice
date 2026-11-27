import { execFile } from "node:child_process";

// Git and other helper programs, run without blocking the event loop. Under load one `git status` can take
// seconds, and a synchronous call stalls every request the server is handling meanwhile, `/api/status` included.
// Use these for anything that runs after startup: request handlers, timers and Pi event handlers.

/** A failed command: `status` is its exit code (undefined when it was killed or could not start). */
export type CommandError = Error & { status?: number; code?: string | number; signal?: NodeJS.Signals | null; killed?: boolean; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number };

export function run(file: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr }); return; }
      reject(Object.assign(error, { status: typeof error.code === "number" ? error.code : undefined, stdout: stdout ?? "", stderr: stderr ?? "" }) as CommandError);
    });
    // The synchronous calls this replaces gave the child an empty stdin. Close ours so a command that reads it sees
    // EOF instead of waiting forever (a credential helper, say).
    child.stdin?.end();
  });
}

/** `git -C repo ...args`, trimmed stdout. Rejects with a `CommandError`. */
export async function git(repo: string, args: string[], options: RunOptions = {}): Promise<string> {
  return (await run("git", ["-C", repo, ...args], options)).stdout.trim();
}

/** `git merge-base --is-ancestor`: false on exit code 1, a rejection for anything else (a missing commit, say). */
export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if ((error as CommandError).status === 1) return false; throw error; }
}

/**
 * `git fetch origin --prune --quiet`. Fetches of one repository with the same timeout that overlap (several cards
 * starting at once, an Approve beside them) share one Git process. Each caller applies its own error policy.
 */
export function fetchOrigin(repo: string, timeoutMs: number): Promise<void> {
  return fetches.run(`${repo}\0${timeoutMs}`, async () => {
    await git(repo, ["fetch", "origin", "--prune", "--quiet"], { timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  });
}

/**
 * Overlapping calls with the same key share one promise instead of each starting the same Git work. The entry is
 * dropped once it settles, so the next call after that reads fresh.
 */
export class Shared {
  private inflight = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const started = work().finally(() => { if (this.inflight.get(key) === started) this.inflight.delete(key); });
    this.inflight.set(key, started);
    return started;
  }
}

/**
 * Runs work for the same key one at a time, in call order. For Git operations that change a repository (merging
 * into main, resetting it), which ran back to back when they were synchronous and must not interleave now.
 */
export class Serial {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(() => work());
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }
  /** Resolves once everything queued so far has finished, so a shutdown can wait before closing the database. */
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all(this.tails.values());
  }
}

const fetches = new Shared();
