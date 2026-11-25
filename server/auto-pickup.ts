import type { Board } from "./board.js";
import type { Worker } from "./worker.js";

// The database claim is the final concurrency/cap guard. This timer only chooses eligible Ready cards, and Review
// cards whose refused push waits for a slot; it never resumes interrupted runs or restarts failed ones, which wait in their lanes without holding up other cards. Like the start
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
    // A refused push that hit the run limit goes first: the operator already asked for it by approving.
    for (const card of this.board.listWaitingHookFixes()) {
      try {
        this.worker.startHookFix(card);
      } catch (error) {
        this.board.noteCard(card.id, `Could not send the refused push's hook output to the agent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const repoBoard of this.board.listBoards().filter(item => item.autoPickupEnabled)) {
      const blocker = this.board.autoPickupBlocker(repoBoard);
      if (!blocker) continue;
      console.log(`[pickup ${repoBoard.repo}] paused: ${blocker.reason}`);
      this.board.pauseAutoPickup(repoBoard.id, blocker.reason);
    }
    // One candidate query per tick, after the pauses above, rather than one per board.
    const byBoard = new Map<string, ReturnType<Board["listAutoPickupCandidates"]>>();
    for (const item of this.board.listAutoPickupCandidates()) byBoard.set(item.board.id, [...byBoard.get(item.board.id) ?? [], item]);
    for (const [boardId, candidates] of byBoard) {
      for (const { card, board: repoBoard } of candidates) {
        // Read fresh each time: every start uses a slot and a daily start, and spend moves.
        const refusal = this.board.autoStartRefusal(this.board.getBoard(boardId) ?? repoBoard);
        if (refusal) break;
        try {
          console.log(`[pickup ${repoBoard.repo}] starting card ${card.id.slice(0, 8)} "${card.title.slice(0, 60)}"`);
          this.worker.start(card, "auto");
        } catch (error) {
          console.error(`[pickup ${repoBoard.repo}] could not start card ${card.id.slice(0, 8)}: ${String(error)}`);
          this.board.pauseAutoPickup(boardId, `Could not start ${card.title}: ${String(error)}`);
          break;
        }
      }
    }
  }
}
