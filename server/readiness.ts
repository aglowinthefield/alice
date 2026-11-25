import type { Board, Card, Run } from "./board.js";
import { CommitHookError, PushHookError, type Integration } from "./integration.js";
import type { PullRequestDraft } from "./pr-draft.js";
import { loopGuards } from "./repo-limits.js";

/**
 * How the repository's hooks went on the card's work when its run reached Review. "passed" names the commit whose
 * pre-push hook passed; Approve pushes exactly that commit without running the hook again. "unchecked" means Bakery
 * could not tell (no network, origin's branch moved), so Approve runs the hooks as before. A "failed" check names the
 * `hook` that refused: "commit" (pre-commit or commit-msg, nothing was committed) or "push". `sentBack` is set when
 * the refusal went back to the agent from here.
 */
export type HookCheck = { state: "queued" | "running" | "passed" | "failed" | "unchecked"; candidate: string | null; detail: string; hook?: "commit" | "push"; sentBack?: boolean };
export type ReadinessProgress = { startedAt: number; steps: { at: number; text: string }[] };
type Stored = { draft?: PullRequestDraft; hooks?: HookCheck };
type Job = { runId: string; abort: AbortController; progress: ReadinessProgress; draft?: Promise<PullRequestDraft>; hooks?: Promise<void>; hookState?: HookCheck };

/** Hook failures in a row sent back to the agent from Review before Bakery leaves the next one for a person. */
const maxHookSendBacks = loopGuards.hookSendBacks;
/** Drafts written at once, so a restart with many cards in Review does not start dozens of Pi processes. */
const draftConcurrency = 2;

/**
 * Gets github-pr cards ready to open their pull request while the operator reviews them, so Approve only pushes.
 * When a run reaches Review it drafts the PR title and body and runs the repository's commit and pre-push hooks on
 * the work (see `Integration.checkHooks`), one card at a time per repository. Both results are stored per run.
 * A refused commit or pre-push hook goes back to the agent right away, up to `maxHookSendBacks` times in a row.
 * Boards with auto-review or automatic pull requests push at Review anyway, so only their draft is shared, on demand.
 */
export class Readiness {
  private jobs = new Map<string, Job>();
  private repoQueues = new Map<string, Promise<void>>();
  private drafting = 0;
  private draftWaiters: (() => void)[] = [];
  constructor(private board: Board, private integration: Integration, private deps: {
    draft: (card: Card, run: Run, onProgress: (step: string) => void) => Promise<PullRequestDraft>;
    /** Sends a refused hook's output to the agent as a new run. False when no run can start yet. */
    sendBack: (card: Card, error: PushHookError | CommitHookError) => boolean;
  }) {}

  private latest(card: Card): Run | undefined {
    const run = this.board.listRuns(card.id)[0];
    return run?.status === "review" && card.status === "review" ? run : undefined;
  }
  private stored(runId: string): Stored {
    try { return JSON.parse(this.board.getReadiness(runId) ?? "{}") as Stored; } catch { return {}; }
  }
  private save(run: Run, change: Stored): void {
    this.board.setReadiness(run.id, run.cardId, JSON.stringify({ ...this.stored(run.id), ...change }));
  }
  private job(card: Card, run: Run): Job {
    let job = this.jobs.get(card.id);
    if (job?.runId !== run.id) {
      job?.abort.abort();
      job = { runId: run.id, abort: new AbortController(), progress: { startedAt: Date.now(), steps: [] } };
      this.jobs.set(card.id, job);
    }
    return job;
  }
  private step(job: Job, text: string): void {
    job.progress.steps.push({ at: Date.now(), text });
    if (job.progress.steps.length > 200) job.progress.steps.shift();
  }
  /** Which parts a card gets at Review: none off github-pr boards, and no hooks where something pushes on its own. */
  private wants(card: Card, run: Run): { draft: boolean; hooks: boolean } {
    const repoBoard = this.board.boardForRepo(card.repo);
    if (!this.board.features.pullRequests || repoBoard?.integration !== "github-pr" || card.prOverrideUrl || run.ciFix || card.prPushedRunId === run.id || !run.worktree)
      return { draft: false, hooks: false };
    if (repoBoard.autoReviewEnabled || repoBoard.autoPullRequestEnabled) return { draft: false, hooks: false };
    // An open PR keeps its title and body, so Approve needs no draft for it.
    return { draft: !(card.prUrl && card.prState === "OPEN"), hooks: true };
  }

  /** Starts whatever the card's Review run still lacks. Safe to call again; finished parts are not redone. */
  prepare(card: Card): void {
    const run = this.latest(card);
    if (!run) return;
    const wants = this.wants(card, run), stored = this.stored(run.id);
    if (!wants.draft && !wants.hooks) return;
    const job = this.job(card, run);
    if (wants.draft && !stored.draft && !job.draft) this.startDraft(card, run, job);
    if (wants.hooks && !stored.hooks && !job.hooks) this.startHooks(card, run, job);
  }

  /**
   * The PR title and body for the card's Review run: the stored draft, the one being written, or a new one. A draft
   * the agent could not write is returned but not kept, so the next request tries again.
   */
  draft(card: Card): Promise<PullRequestDraft> {
    const run = this.board.listRuns(card.id)[0];
    if (!run) return Promise.reject(new Error("The card has no run to open a pull request for"));
    const stored = this.stored(run.id).draft;
    if (stored) return Promise.resolve(stored);
    const job = this.job(card, run);
    return job.draft ?? this.startDraft(card, run, job);
  }

  private startDraft(card: Card, run: Run, job: Job): Promise<PullRequestDraft> {
    const pending = (async () => {
      await this.draftSlot();
      try {
        const draft = await this.deps.draft(card, run, text => this.step(job, text));
        if (draft.source === "agent" || !draft.problem) this.save(run, { draft });
        return draft;
      } finally { this.releaseDraftSlot(); }
    })();
    job.draft = pending;
    // A failed or unkept draft is retried by the next request.
    pending.then(draft => { if (job.draft === pending && draft.source === "card" && draft.problem) job.draft = undefined; },
      () => { if (job.draft === pending) job.draft = undefined; });
    return pending;
  }
  private async draftSlot(): Promise<void> {
    if (this.drafting < draftConcurrency) { this.drafting++; return; }
    await new Promise<void>(resolve => this.draftWaiters.push(resolve));
  }
  private releaseDraftSlot(): void {
    const next = this.draftWaiters.shift();
    if (next) next(); else this.drafting--;
  }

  private startHooks(card: Card, run: Run, job: Job): void {
    job.hookState = { state: "queued", candidate: null, detail: "" };
    const previous = this.repoQueues.get(card.repo) ?? Promise.resolve();
    const current = previous.then(() => this.checkHooks(card.id, run, job));
    job.hooks = current;
    const tail = current.catch(() => {});
    this.repoQueues.set(card.repo, tail);
    void tail.then(() => { if (this.repoQueues.get(card.repo) === tail) this.repoQueues.delete(card.repo); });
  }
  private async checkHooks(cardId: string, run: Run, job: Job): Promise<void> {
    const card = this.board.getCard(cardId);
    // Approve took over while this waited in the queue, or a new attempt started.
    if (job.abort.signal.aborted || job.hookState?.state !== "queued" || !card || this.latest(card)?.id !== run.id) return;
    job.hookState = { state: "running", candidate: null, detail: "" };
    let result: HookCheck;
    try {
      const checked = await this.integration.checkHooks(card, job.abort.signal, text => this.step(job, text));
      result = { state: checked.state, candidate: checked.candidate, detail: checked.detail };
      this.step(job, checked.state === "passed" ? "The pre-push hook passed; Approve pushes without running it again" : "Could not run the pre-push hook here; Approve runs it");
    } catch (error) {
      if (job.abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof PushHookError) && !(error instanceof CommitHookError)) {
        result = { state: "unchecked", candidate: null, detail: message };
        // Only a failed commit is news: a worktree Bakery cannot inspect says so on Approve anyway.
        if (/^diff failed|uncommitted changes after/.test(message)) this.board.noteCard(cardId, `Bakery could not get this card's commit ready to push at Review, so Approve runs the hooks itself: ${message.slice(0, 1500)}`);
      } else {
        const hook = error instanceof PushHookError ? "push" : "commit";
        const name = hook === "push" ? "The pre-push hook" : "The repository's commit hook";
        result = { state: "failed", candidate: error instanceof PushHookError ? error.sha : null, detail: message, hook, sentBack: false };
        this.step(job, hook === "push" ? "The pre-push hook refused the commit" : "A commit hook refused the card's work, so nothing was committed");
        const streak = this.sendBackStreak(cardId, run.id);
        if (streak >= maxHookSendBacks) {
          this.board.noteCard(cardId, `${name} refused this attempt at Review too. Bakery already sent it back ${streak} times in a row, so a person decides now; Approve shows the output.`);
        } else {
          result.sentBack = true;
          this.save(run, { hooks: result });
          job.hookState = result;
          try {
            if (!this.deps.sendBack(card, error)) this.board.noteCard(cardId, `${name} refused this attempt at Review. Its output goes to the agent once a run can start.`);
          } catch (sendError) {
            this.board.noteCard(cardId, `${name} refused this attempt at Review, and Bakery could not send it back to the agent: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          }
          return;
        }
      }
    }
    const fresh = this.board.getCard(cardId);
    if (!fresh || this.latest(fresh)?.id !== run.id) return;
    this.save(run, { hooks: result });
    job.hookState = result;
  }
  /** Runs before `runId`, newest first, whose refused hook went back to the agent from Review. */
  private sendBackStreak(cardId: string, runId: string): number {
    let streak = 0;
    for (const run of this.board.listRuns(cardId).filter(item => item.id !== runId)) {
      if (!this.stored(run.id).hooks?.sentBack) break;
      streak++;
    }
    return streak;
  }

  /**
   * For Approve: waits for a hook check already running on the card, then returns the commit whose pre-push hook
   * passed, or null. A check still queued behind another card is dropped, since Approve runs the hooks itself.
   */
  async passedCommit(cardId: string): Promise<string | null> {
    const card = this.board.getCard(cardId), run = card && this.latest(card);
    if (!run) return null;
    const job = this.jobs.get(cardId);
    if (job?.runId === run.id && job.hookState?.state === "queued") {
      job.hookState = { state: "unchecked", candidate: null, detail: "Approve ran before the check started" };
      return null;
    }
    if (job?.runId === run.id && job.hooks) await job.hooks.catch(() => {});
    const hooks = this.stored(run.id).hooks;
    return hooks?.state === "passed" ? hooks.candidate : null;
  }

  /** What the PR dialog shows: the steps so far, and the hook check (in progress or stored). */
  status(cardId: string): { progress: ReadinessProgress; hooks: HookCheck | null } {
    const card = this.board.getCard(cardId), run = card && this.board.listRuns(cardId)[0];
    const job = this.jobs.get(cardId);
    const live = job && run && job.runId === run.id ? job : undefined;
    const hooks = (run && this.stored(run.id).hooks) ?? live?.hookState ?? null;
    return { progress: live?.progress ?? { startedAt: 0, steps: [] }, hooks };
  }

  /** A new attempt started on the card: stop its hook check, which would race the agent in the worktree. */
  cancel(cardId: string): void {
    const job = this.jobs.get(cardId);
    if (!job) return;
    job.abort.abort();
    this.jobs.delete(cardId);
  }
}
