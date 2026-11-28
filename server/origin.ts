import { fetchOrigin, git as runGit } from "./git-async.js";

// Local-mode boards never push, but their `main` should still track the shared repository when there is one.
// These helpers fetch `origin` best-effort: being offline is a warning, never a block.

function git(repo: string, args: string[], timeout?: number): Promise<string> {
  return runGit(repo, args, { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

export async function hasOrigin(repo: string): Promise<boolean> {
  try { await git(repo, ["remote", "get-url", "origin"]); return true; } catch { return false; }
}

/** `git fetch origin` with a bounded timeout. Returns a warning instead of throwing when the fetch fails. */
export async function fetchOriginBestEffort(repo: string, timeoutMs = 30_000): Promise<string | null> {
  // Overlapping fetches of this repository with the same timeout share one Git process.
  try { await fetchOrigin(repo, timeoutMs); return null; }
  catch (error) {
    const failure = error as { stderr?: Buffer | string; code?: string; signal?: string };
    const detail = failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM" ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : (failure.stderr?.toString() || String(error)).trim().slice(0, 500);
    return `git fetch origin failed (${detail}); continuing with the last fetched origin/main`;
  }
}

/** Commits on `ref` not on origin/main (`ahead`) and the reverse (`behind`), or null when origin/main is unknown. */
export async function compareWithOriginMain(repo: string, ref = "main"): Promise<{ ahead: number; behind: number } | null> {
  try { await git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]); } catch { return null; }
  const [ahead, behind] = (await git(repo, ["rev-list", "--left-right", "--count", `${ref}...refs/remotes/origin/main`])).split(/\s+/).map(Number);
  return { ahead, behind };
}

/**
 * Brings local main level with origin/main when it is behind: a fast-forward, or a rebase of unpushed local commits
 * onto it. Only from a clean tracked checkout. A rebase that conflicts is aborted so main is left as it was.
 * Returns what it did, or null when it did not touch main (the caller then reports `behindOriginMessage`).
 */
export async function syncMainWithOrigin(repo: string, state: { ahead: number; behind: number }): Promise<string | null> {
  if (!state.behind) return null;
  try {
    if (await git(repo, ["status", "--porcelain", "--untracked-files=no"])) return null;
    if (!state.ahead) { await git(repo, ["merge", "--ff-only", "--quiet", "refs/remotes/origin/main"]); return `Fast-forwarded main over ${state.behind} commit${state.behind === 1 ? "" : "s"} from origin/main`; }
    try { await git(repo, ["rebase", "refs/remotes/origin/main"]); }
    catch { try { await git(repo, ["rebase", "--abort"]); } catch { /* Nothing in progress. */ } return null; }
    return `Rebased ${state.ahead} local commit${state.ahead === 1 ? "" : "s"} on main onto origin/main`;
  } catch { return null; }
}

/** Why approving into local main must wait, or null. Ahead of origin/main is fine; behind or diverged is not. */
export function behindOriginMessage(repo: string, state: { ahead: number; behind: number }): string | null {
  if (!state.behind) return null;
  const count = `${state.behind} commit${state.behind === 1 ? "" : "s"}`;
  if (state.ahead) return `Local main has diverged from origin/main (${state.ahead} local, ${count} behind). Reconcile main with origin/main at ${repo}, then approve again`;
  return `Local main is ${count} behind origin/main. Update main first (git -C ${repo} merge --ff-only origin/main), then refresh the diff and approve again`;
}
