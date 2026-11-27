import type { Board, Run } from "./board.js";
import { boardGithubRepo } from "./github.js";
import { monitorsGithub } from "./sentinel.js";
import type { PrLocks } from "./pr-locks.js";
import type { SentinelStore } from "./sentinel-store.js";

type Target = { repo: string; number: number; holder: string };
type Held = { target: Target; pending?: Promise<void>; timer?: ReturnType<typeof setInterval> };

/** Lock refresh interval. Well inside the 30-minute lifetime, so a long run keeps its lock. */
const refreshMs = 10 * 60_000;

/**
 * Locks a card's open PR for as long as one of its runs is active: taken when the run starts, refreshed while it
 * runs, released when it finishes. A run that dies without finishing leaves the lock to expire, which is the
 * signal the sentinel waits for. Cards without a PR yet (a first feature run) take no lock.
 */
export class RunLocks {
  /** Each locked run's target, captured at start so the release still finds it after the PR merges or closes. */
  private held = new Map<string, Held>();
  private handling = new Set<Promise<void>>();
  private stopped = false;
  constructor(private readonly board: Board, private readonly locks: PrLocks, private readonly store: SentinelStore, private readonly enabled = true) {
    if (enabled) board.onRun((event, run) => {
      const job = this.handle(event, run).finally(() => this.handling.delete(job));
      this.handling.add(job);
      return job;
    });
  }
  /** Resolves once every start and finish handled so far has settled. */
  async idle(): Promise<void> { while (this.handling.size) await Promise.allSettled(this.handling); }
  /** Stops refreshing. Targets are kept, so runs that finish during shutdown still release their locks. */
  shutdown(): void {
    this.stopped = true;
    for (const held of this.held.values()) clearInterval(held.timer);
  }

  /** Where the run's lock goes: the PR, and who holds it. A sentinel card's PR comes from its attempt record. */
  private target(run: Run): Target | undefined {
    const card = this.board.getCard(run.cardId);
    const repoBoard = card && this.board.listBoards().find(item => item.repo === card.repo);
    if (!card || !repoBoard || !monitorsGithub(repoBoard)) return undefined;
    const repo = boardGithubRepo(repoBoard);
    const sentinelPr = this.store.attemptPr(card.id);
    if (sentinelPr !== undefined) return { repo, number: sentinelPr, holder: `sentinel:${card.id}` };
    if (card.prNumber && card.prState !== "MERGED" && card.prState !== "CLOSED") return { repo, number: card.prNumber, holder: card.id };
    return undefined;
  }

  /** Takes or refreshes the lock. A call while one is still in flight joins it, so refreshes never overlap. */
  private take(held: Held): Promise<void> {
    if (held.pending) return held.pending;
    const { repo, number, holder } = held.target;
    const pending = this.locks.acquire(repo, number, holder).then(() => undefined).finally(() => { if (held.pending === pending) held.pending = undefined; });
    held.pending = pending;
    return pending;
  }

  private async handle(event: "started" | "finished", run: Run): Promise<void> {
    try {
      if (event === "started") {
        const target = this.target(run);
        if (!target) return;
        const held: Held = { target };
        this.held.set(run.id, held);
        await this.take(held);
        if (this.held.get(run.id) === held && !this.stopped) held.timer = setInterval(() => void this.take(held).catch(() => undefined), refreshMs);
      } else {
        const held = this.held.get(run.id);
        if (!held) return;
        this.held.delete(run.id);
        clearInterval(held.timer);
        // Called before any await: PrLocks runs it after a take or refresh still in flight, and before a retry's take.
        await this.locks.release(held.target.repo, held.target.number, held.target.holder);
      }
    } catch (error) { console.error(`PR lock for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
