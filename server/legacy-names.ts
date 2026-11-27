// Bakery is becoming Alice. For one release Bakery's old names keep working, and this module is the one place that
// knows them, so dropping them later is this file plus its call sites.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Each `BAKERY_*` setting fills its `ALICE_*` name when that is unset, so code reads only `ALICE_*`. It runs when the
 * module loads: entry points import it before anything that reads the environment.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env))
    if (name.startsWith("BAKERY_") && value !== undefined) env[`ALICE_${name.slice("BAKERY_".length)}`] ??= value;
}
adoptLegacyEnv();

/**
 * Where the board's data lives: `ALICE_DATA_DIR` (or `BAKERY_DATA_DIR`), else an existing `~/.local/share/bakery`,
 * which stays put because its database stores absolute paths, else `~/.local/share/alice`.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.ALICE_DATA_DIR ?? env.BAKERY_DATA_DIR;
  if (set) return set;
  const legacy = join(homedir(), ".local", "share", "bakery");
  return existsSync(legacy) ? legacy : join(homedir(), ".local", "share", "alice");
}

/** The board's database in `dir`: `alice.sqlite`, or `bakery.sqlite` when only that one exists there. */
export function databaseFile(dir: string): string {
  const legacy = join(dir, "bakery.sqlite"), current = join(dir, "alice.sqlite");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** The branches a card's PR may come from, newest name first: cards opened before the rename push `bakery/<id>`. */
export const cardBranches = (cardId: string): string[] => [`alice/${cardId}`, `bakery/${cardId}`];

/**
 * The branch a card works on in `repo`: the first of `cardBranches` that exists there, else `alice/<id>`. A card whose
 * worktree was made before the rename stays on `bakery/<id>`.
 */
export function cardBranch(repo: string, cardId: string): string {
  const branches = cardBranches(cardId);
  const exists = (branch: string) => {
    try { execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "ignore" }); return true; }
    catch { return false; }
  };
  return branches.find(exists) ?? branches[0];
}
