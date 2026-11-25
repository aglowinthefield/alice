import { RunLimitError, type Board } from "./board.js";
import type { Worker } from "./worker.js";

// The database claim is the final concurrency/cap guard. This timer only chooses eligible Ready cards, and Review
// cards whose refused push or reviewer send-back waits for a slot; it never resumes interrupted runs or retries failed ones. Like the start
// limit, a reached cost budget only makes pickup wait; spend already running is never stopped.
export class AutoPickup {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly board: Board, private readonly worker: Worker) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 2000);
    this.tick();
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  tick(): void {
    this.board.resumeResolvedAutoPickup();
    // A refused push that hit the run limit goes first: the operator already asked for it by approving.
    for (const card of this.board.listWaitingHookFixes()) {
      try {
        this.worker.startHookFix(card);
      } catch (error) {
        this.board.noteCard(card.id, `Could not send the refused push's hook output to the agent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // So does a reviewer send-back the run limit refused: the card is mid-review, and the reviewer's changes wait on its run.
    for (const { card, why } of this.board.listSlotQueuedStarts()) {
      // Approved, rejected or started by hand meanwhile: nothing is left to start.
      if (!["ready", "failed", "review"].includes(card.status)) { this.board.cancelQueuedStart(card.id); continue; }
      const repoBoard = this.board.boardForRepo(card.repo);
      if (repoBoard?.autoPickupEnabled && this.board.runningCount(card.repo) >= repoBoard.pickupConcurrency) continue;
      try {
        this.worker.start(card, "manual", why);
        this.board.cancelQueuedStart(card.id);
      } catch (error) {
        if (error instanceof RunLimitError) continue;
        this.board.cancelQueuedStart(card.id);
        this.board.noteCard(card.id, `Bakery could not start the queued attempt: ${error instanceof Error ? error.message : String(error)}. Run it again, or review it yourself.`);
      }
    }
    for (const repoBoard of this.board.listBoards().filter(item => item.autoPickupEnabled)) {
      const blocker = this.board.autoPickupBlocker(repoBoard);
      if (blocker) {
        console.log(`[pickup ${repoBoard.repo}] paused: ${blocker.reason}`);
        this.board.pauseAutoPickup(repoBoard.id, blocker.reason, blocker.kind === "failed_run");
        continue;
      }
      const candidates = this.board.listAutoPickupCandidates().filter(item => item.board.id === repoBoard.id);
      for (const { card } of candidates) {
        const limited = (this.board.runningCount(repoBoard.repo) >= repoBoard.pickupConcurrency ||
          (repoBoard.pickupDailyLimit > 0 && this.board.autoStartsToday(repoBoard.repo) >= repoBoard.pickupDailyLimit));
        if (limited || this.board.autoPickupBudgetReached(repoBoard.repo)) { if (limited) continue; break; }
        try {
          console.log(`[pickup ${repoBoard.repo}] starting card ${card.id.slice(0, 8)} "${card.title.slice(0, 60)}"`);
          this.worker.start(card, "auto");
        } catch (error) {
          console.error(`[pickup ${repoBoard.repo}] could not start card ${card.id.slice(0, 8)}: ${String(error)}`);
          this.board.pauseAutoPickup(repoBoard.id, `Could not start ${card.title}: ${String(error)}`);
          break;
        }
      }
    }
  }
}
