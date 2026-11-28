import { RunLimitError, type Board } from "./board.js";
import { atRunCapacity } from "./repo-limits.js";
import { sendBackReason } from "./auto-review.js";
import { StartRefusedError, type Worker } from "./worker.js";

// The database claim is the final concurrency/cap guard. This timer only chooses eligible Ready cards, and Review
// cards whose refused push or reviewer send-back waits for a slot; it never resumes interrupted runs or restarts failed ones, which wait in their lanes without holding up other cards. Like the start
// limit, a reached cost budget only makes pickup wait; spend already running is never stopped.
export class AutoPickup {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly board: Board, private readonly worker: Worker) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private ticking: Promise<void> | null = null;
  /**
   * Starts what is due. Starts run Git (a fetch can take minutes), so a tick can outlast the 2-second interval; a tick
   * that overlaps one still running shares it instead of starting the same cards again.
   */
  tick(): Promise<void> {
    this.ticking ??= this.pickUp().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  private async pickUp(): Promise<void> {
    // A refused push that hit the run limit goes first: the operator already asked for it by approving.
    for (const card of this.board.listWaitingHookFixes()) {
      try {
        await this.worker.startHookFix(card);
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
        await this.worker.start(card, "manual", why);
      } catch (error) {
        // A run limit or a restart drain only delays it: the entry stays queued for a later tick.
        if (error instanceof RunLimitError || error instanceof StartRefusedError) continue;
        this.board.cancelQueuedStart(card.id);
        // A reviewer send-back that cannot start becomes a handoff, so the card's draft pull request carries the findings.
        const runId = this.board.listRuns(card.id)[0]?.id;
        if (why === sendBackReason && card.status === "review" && runId) this.board.handOffSendBack(runId, "no rerun could be started");
        this.board.noteCard(card.id, `Alice could not start the queued attempt: ${error instanceof Error ? error.message : String(error)}. Run it again, or review it yourself.`);
      }
    }
    for (const repoBoard of this.board.listBoards().filter(item => item.autoPickupEnabled)) {
      const blocker = this.board.autoPickupBlocker(repoBoard);
      if (!blocker) continue;
      console.log(`[pickup ${repoBoard.repo}] paused: ${blocker}`);
      this.board.pauseAutoPickup(repoBoard.id, blocker);
    }
    // One candidate query per tick, after the pauses above, rather than one per board.
    const byBoard = new Map<string, ReturnType<Board["listAutoPickupCandidates"]>>();
    for (const item of this.board.listAutoPickupCandidates()) byBoard.set(item.board.id, [...byBoard.get(item.board.id) ?? [], item]);
    for (const [boardId, candidates] of byBoard) {
      for (const { card, board: repoBoard } of candidates) {
        // Read fresh each time: every start uses a slot and a daily start, and spend moves. Each start is awaited, so
        // its claim counts before the next card is checked.
        const refusal = this.board.autoStartRefusal(this.board.getBoard(boardId) ?? repoBoard);
        if (refusal) break;
        // Starting the cards before this one awaited Git, so this one may have been started or moved meanwhile.
        const fresh = this.board.getCard(card.id);
        if (fresh?.status !== "ready") continue;
        try {
          console.log(`[pickup ${repoBoard.repo}] starting card ${card.id.slice(0, 8)} "${card.title.slice(0, 60)}"`);
          await this.worker.start(fresh, "auto");
        } catch (error) {
          // A start runs Git before it claims, so the world can move under it. None of these is the board's fault,
          // and pausing for them would leave pickup off until someone noticed: a restart drain began, the board hit
          // its run limit, or the card stopped being a candidate (moved, started by hand, limits reached).
          if (error instanceof StartRefusedError) { console.log(`[pickup ${repoBoard.repo}] stopped: ${error.message}`); return; }
          if (error instanceof RunLimitError) break;
          if (!this.board.listAutoPickupCandidates().some(item => item.card.id === card.id)) {
            console.log(`[pickup ${repoBoard.repo}] card ${card.id.slice(0, 8)} is no longer a candidate: ${String(error)}`);
            continue;
          }
          console.error(`[pickup ${repoBoard.repo}] could not start card ${card.id.slice(0, 8)}: ${String(error)}`);
          this.board.pauseAutoPickup(boardId, `Could not start ${card.title}: ${String(error)}`);
          break;
        }
      }
    }
  }
}
