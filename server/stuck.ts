// Spots a card run going in circles from its Pi event stream, so the operator hears about it well before the run
// timeout. The thresholds come from 807 finished card runs with Pi session logs (Bakery's own board, measured
// 2026-11-24): 736 that reached Review and 71 killed by the 60-minute run timeout. Session logs hold tool calls, not
// the worktree, so there a "change" was an edit or write call or a bash command that plainly writes a file; the
// worker sees real worktree changes, so it should flag a little less often. Rerun that measurement before changing
// the numbers; the scripts are attached to the Bakery card that added this file (33139a26).

/** A run is flagged when one tool call (same tool, same arguments) makes up this many of its last `REPEAT_WINDOW` calls. */
// No run in the sample got past 4; the 4 runs that reached 4 all finished and reached Review.
export const REPEAT_LIMIT = 5;
/** How many recent tool calls the repeat check looks back over. */
export const REPEAT_WINDOW = 20;
/** A run that has changed files is flagged after this many turns in a row with no further change to the worktree. */
// 8 of 71 timed-out runs (11%) and 16 of 736 successful ones (2.2%) had a stretch this long; at 20 turns it was 3.5% of
// successful runs, at 30 only 2 timed-out runs.
export const IDLE_TURNS_AFTER_CHANGE = 25;
/** A run that has not changed any file yet is flagged after this many turns. Reading and planning come first, so this is longer. */
// No successful run went 60 turns before its first change (9 went 40, 3 went 50); 1 timed-out run did.
export const IDLE_TURNS_BEFORE_CHANGE = 60;

/** Step-back message Bakery steers a flagged run with, once. */
export const STUCK_MESSAGE = "Bakery: you seem stuck. Step back before your next tool call: say in one or two sentences what you are trying to establish and why the last attempts did not get there, then pick a different approach. If something outside this worktree blocks you, stop and write your report saying what blocks you.";

/**
 * Tracks one run. Feed it every tool call and every turn end; it returns a reason the first time the run looks stuck
 * and null otherwise, so a run is flagged (and the operator notified) at most once.
 */
export class StuckDetector {
  private recent: string[] = [];
  private changed = false;
  private idleTurns = 0;
  private flagged = false;

  /** A tool call started. `args` is the call's arguments as Pi sent them. */
  toolCall(name: string, args: unknown): string | null {
    const signature = `${name}\u0000${stableJson(args)}`;
    this.recent.push(signature);
    if (this.recent.length > REPEAT_WINDOW) this.recent.shift();
    const repeats = this.recent.filter(item => item === signature).length;
    return repeats >= REPEAT_LIMIT ? this.flag(`repeated the same ${name} call ${repeats} times in its last ${this.recent.length} tool calls`) : null;
  }

  /** A turn ended. `changed` says whether the worktree changed during it. */
  turnEnd(changed: boolean): string | null {
    if (changed) { this.changed = true; this.idleTurns = 0; return null; }
    this.idleTurns++;
    if (this.changed && this.idleTurns >= IDLE_TURNS_AFTER_CHANGE) return this.flag(`changed no files for ${this.idleTurns} turns`);
    if (!this.changed && this.idleTurns >= IDLE_TURNS_BEFORE_CHANGE) return this.flag(`changed no files in ${this.idleTurns} turns`);
    return null;
  }

  private flag(reason: string): string | null {
    if (this.flagged) return null;
    this.flagged = true;
    return reason;
  }
}

/** JSON with object keys sorted, so two calls with the same arguments in a different order count as the same call. */
function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}
