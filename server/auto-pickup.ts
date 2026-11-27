import { RunLimitError, type Board } from "./board.js";
import { atRunCapacity } from "./repo-limits.js";
import type { Worker } from "./worker.js";

// The database claim is the final concurrency/cap guard. This timer only chooses eligible Ready cards, and Review
// cards whose refused push or reviewer send-back waits for a slot; it never resumes interrupted runs or restarts failed ones, which wait in their lanes without holding up other cards. Like the start
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
    // So does a reviewer send-back the run limit refused: the card is mid-review, and the reviewer's changes wait on its run.
    for (const { card, why } of this.board.listSlotQueuedStarts()) {
      // Approved or rejected meanwhile: nothing is left to start. Any claimed run already consumed the entry.
      if (!["ready", "failed", "review"].includes(card.status)) { this.board.cancelQueuedStart(card.id); continue; }
      const repoBoard = this.board.boardForRepo(card.repo);
      if ((repoBoard?.autoPickupEnabled && atRunCapacity(repoBoard, this.board.runningCount(card.repo))) || this.board.atMachineCapacity()) continue;
      try {
        this.worker.start(card, "manual", why);
      } catch (error) {
        if (error instanceof RunLimitError) continue;
        this.board.cancelQueuedStart(card.id);
        this.board.noteCard(card.id, `Alice could not start the queued attempt: ${error instanceof Error ? error.message : String(error)}. Run it again, or review it yourself.`);
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
