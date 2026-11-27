// Bakery is becoming Alice. For one release Bakery's old names keep working, and this module is the one place that
// knows them, so dropping them later is this file plus its call sites.
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

/** The branches a card's PR may come from, newest name first: cards opened before the rename push `bakery/<id>`. */
export const cardBranches = (cardId: string): string[] => [`alice/${cardId}`, `bakery/${cardId}`];
