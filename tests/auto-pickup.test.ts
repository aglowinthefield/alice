import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Integration } from "../server/integration.js";
import { Worker } from "../server/worker.js";
import { AutoPickup } from "../server/auto-pickup.js";
import { AutoReview, sendBackReason } from "../server/auto-review.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alice-pickup-")), repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "fake-pi");
  mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  // Each run appends its prompt (the last argument) to `prompts`, then waits for `release`.
  writeFileSync(fakePi, `#!/bin/sh\nfor prompt; do :; done\nprintf '%s\\n' "$prompt" >> '${join(dir, "prompts")}'\nwhile [ ! -f '${join(dir, "release")}' ]; do sleep 0.05; done\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`); chmodSync(fakePi, 0o755);
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  const worker = new Worker(board, data, fakePi), pickup = new AutoPickup(board, worker);
  const card = (title: string) => board.setStatus(board.createCard({ title, body: "Small change", repo }).id, "ready");
  return { dir, repo, data, board, repoBoard, worker, pickup, card, release: () => writeFileSync(join(dir, "release"), "ok"),
    // Makes the next fake Pi wait again. A pickup tick awaits each start's Git, so with the release file left in place a
    // run could finish mid-tick and free its slot for another card.
    hold: () => rmSync(join(dir, "release"), { force: true }), close: async () => { await worker.shutdown(); board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for fake Pi"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test("auto-pickup is opt-in, starts oldest Ready cards, and counts manual runs toward concurrency", async () => {
  const item = fixture();
  try {
    const manual = item.card("Manual"), first = item.card("First"), second = item.card("Second"), third = item.card("Third");
    await item.worker.start(manual);
    await item.pickup.tick();
    assert.equal(item.board.listRuns(first.id).length, 0, "disabled boards do not start Pi");
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    await item.pickup.tick();
    assert.equal(item.board.listRuns(first.id)[0]?.status, "running");
    assert.equal(item.board.listRuns(first.id)[0]?.startedBy, "auto");
    assert.equal(item.board.listRuns(manual.id)[0]?.startedBy, "manual");
    assert.equal(item.board.listRuns(second.id).length, 0, "manual run occupies one of two slots");
    await assert.rejects(async () => item.worker.start(second), /2-run concurrency limit/, "manual start cannot bypass the shared cap");
    assert.equal(item.board.listRuns(second.id).length, 0);
    item.release();
    await waitFor(() => item.board.getCard(manual.id)?.status === "review" && item.board.getCard(first.id)?.status === "review");
    item.hold();
    await item.pickup.tick();
    assert.equal(item.board.listRuns(second.id)[0]?.status, "running");
    assert.equal(item.board.listRuns(third.id)[0]?.status, "running");
    item.release();
    await waitFor(() => item.board.getCard(second.id)?.status === "review" && item.board.getCard(third.id)?.status === "review");
    await item.pickup.tick();
    assert.equal(item.board.autoStartsToday(item.repo), 3);
    assert.equal(item.board.listRuns(first.id).length, 1, "reviewed cards never restart automatically");
  } finally { await item.close(); }
});

test("pickup starts the highest priority Ready card first, then the oldest", async () => {
  const item = fixture();
  try {
    const ready = (title: string, priority: number) => item.board.setStatus(item.board.createCard({ title, body: "Small change", repo: item.repo, priority }).id, "ready");
    const oldLow = ready("Old low", -1), oldNormal = ready("Old normal", 0), high = ready("High", 1), newerUrgent = ready("Newer urgent", 2), newestUrgent = ready("Newest urgent", 2);
    assert.deepEqual(item.board.listCards(item.repo).map(card => card.title), ["Newest urgent", "Newer urgent", "High", "Old normal", "Old low"],
      "listing keeps newest-first within a priority");
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    assert.deepEqual(item.board.listAutoPickupCandidates().map(({ card }) => card.title), ["Newer urgent", "Newest urgent", "High", "Old normal", "Old low"]);
    await item.pickup.tick();
    assert.deepEqual([newerUrgent, newestUrgent, high, oldNormal, oldLow].map(card => item.board.listRuns(card.id).length), [1, 1, 0, 0, 0]);
    item.release();
    await waitFor(() => item.board.getCard(newerUrgent.id)?.status === "review" && item.board.getCard(newestUrgent.id)?.status === "review");
    item.hold();
    item.board.updateCard(oldLow.id, { title: "Old low", body: "Small change", repo: item.repo, priority: 50 });
    await item.pickup.tick();
    assert.deepEqual([high, oldLow, oldNormal].map(card => item.board.listRuns(card.id).length), [1, 1, 0], "a raised priority overtakes older Normal cards; ties go to the oldest");
    item.release();
    await waitFor(() => item.board.getCard(high.id)?.status === "review" && item.board.getCard(oldLow.id)?.status === "review");
  } finally { await item.close(); }
});

test("turning off pickup blocks new runs but leaves already running Pi alone", async () => {
  const item = fixture();
  try {
    const first = item.card("First"), second = item.card("Second");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    item.board.setAutoPickup(item.repoBoard.id, false, 1);
    await item.pickup.tick();
    assert.equal(item.board.getCard(first.id)?.status, "running");
    assert.equal(item.board.listRuns(second.id).length, 0);
    item.release();
    await waitFor(() => item.board.getCard(first.id)?.status === "review");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(second.id).length, 0);
  } finally { await item.close(); }
});

test("a failed automatic run waits in Failed while pickup starts the next card", async () => {
  const item = fixture();
  try {
    writeFileSync(join(item.dir, "fake-pi"), "#!/bin/sh\nexit 2\n");
    const first = item.card("Will fail"), second = item.card("Starts anyway");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(first.id)?.status === "failed");
    await item.pickup.tick();
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, true);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupError, "");
    assert.equal(item.board.listRuns(second.id)[0]?.startedBy, "auto", "the next Ready card starts");
    await waitFor(() => item.board.getCard(second.id)?.status === "failed");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(first.id).length, 1, "pickup never restarts a failed card");
  } finally { await item.close(); }
});
test("an explicit disable or a pause never resumes by itself", async () => {
  const item = fixture();
  try {
    const waiting = item.card("Waiting");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    item.board.setAutoPickup(item.repoBoard.id, false, 1);
    await item.pickup.tick();
    assert.equal(item.board.listRuns(waiting.id).length, 0);
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    item.board.pauseAutoPickup(item.repoBoard.id, "Could not start a card");
    await item.pickup.tick();
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, false);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupError, "Could not start a card");
    assert.equal(item.board.listRuns(waiting.id).length, 0);
  } finally { await item.close(); }
});
test("boards an older version paused for a failed run resume on startup", async () => {
  const item = fixture();
  let reopened: Board | undefined;
  try {
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    const db = new DatabaseSync(join(item.dir, "board.sqlite"));
    try {
      db.exec("ALTER TABLE boards ADD COLUMN autoPickupResumeOnResolution INTEGER NOT NULL DEFAULT 0");
      db.prepare("UPDATE boards SET autoPickupEnabled=0, autoPickupError=?, autoPickupResumeOnResolution=1 WHERE id=?")
        .run("An automatic run failed; inspect and integrate its card before pickup resumes", item.repoBoard.id);
    } finally { db.close(); }
    reopened = new Board(join(item.dir, "board.sqlite"));
    assert.equal(reopened.getBoard(item.repoBoard.id)?.autoPickupEnabled, true);
    assert.equal(reopened.getBoard(item.repoBoard.id)?.autoPickupError, "");
    const check = new DatabaseSync(join(item.dir, "board.sqlite"));
    try { assert.equal((check.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('boards') WHERE name='autoPickupResumeOnResolution'").get() as { n: number }).n, 0); }
    finally { check.close(); }
  } finally { reopened?.close(); await item.close(); }
});
test("with limits off, a used-up start limit and budget do not stop pickup, and concurrency still does", async () => {
  const item = fixture();
  try {
    item.board.setAutoPickup(item.repoBoard.id, true, 1, 1, 0.01);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.limitsEnabled, false, "limits are off by default");
    const first = item.card("First"), second = item.card("Second");
    await item.pickup.tick();
    assert.equal(item.board.getCard(first.id)?.status, "running");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(second.id).length, 0, "one run at a time still holds");
    item.release();
    await waitFor(() => item.board.getCard(first.id)?.status === "review");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(second.id)[0]?.startedBy, "auto", "the 1-start limit does not apply while limits are off");
    item.board.setLimitsEnabled(item.repoBoard.id, true);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupNextAt !== null, true, "turning limits on applies the stored limit");
  } finally { await item.close(); }
});

test("a pickup tick looks up candidates once, and Ready cards are built without loading boards", async () => {
  const item = fixture();
  try {
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    const ready = item.card("Ready one");
    const listBoards = item.board.listBoards.bind(item.board);
    item.board.listBoards = () => { throw new Error("a Ready card must not load every board"); };
    assert.equal(item.board.getCard(ready.id)?.status, "ready");
    item.board.listBoards = listBoards;
    let lookups = 0;
    const candidates = item.board.listAutoPickupCandidates.bind(item.board);
    item.board.listAutoPickupCandidates = () => { lookups++; return candidates(); };
    await item.pickup.tick();
    assert.equal(lookups, 1);
    assert.equal(item.board.getCard(ready.id)?.status, "running");
    item.release();
    await waitFor(() => item.board.getCard(ready.id)?.status === "review");
  } finally { await item.close(); }
});

test("the machine-wide agent limit holds pickup and automatic starts on every board, but a person's run still starts", async () => {
  const item = fixture();
  try {
    item.board.updateSettings({ maxActiveAgents: 1 });
    assert.throws(() => item.board.updateSettings({ maxActiveAgents: 33 }), /0 \(automatic\) or from 1 to 32/);
    assert.throws(() => item.board.updateSettings({ maxActiveAgents: -1 }), /0 \(automatic\)/);
    item.board.setAutoPickup(item.repoBoard.id, true, 3);
    const first = item.card("First"), second = item.card("Second"), mine = item.card("Mine");
    await item.pickup.tick();
    await item.pickup.tick();
    assert.equal(item.board.getCard(first.id)?.status, "running");
    assert.equal(item.board.listRuns(second.id).length, 0, "the board has room but the machine does not");
    assert.deepEqual(item.board.machineCapacity(), { setting: 1, limit: 1, active: 1 });
    await assert.rejects(async () => item.worker.start(item.board.getCard(second.id)!, "manual", "to fix failing CI"), /limit of 1 agents at once across all boards/,
      "automatic fixes started as manual runs wait too");
    await item.worker.start(item.board.getCard(mine.id)!, "manual", "", undefined, true);
    assert.equal(item.board.getCard(mine.id)?.status, "running", "a run the operator starts is never refused");
    item.release();
    await waitFor(() => item.board.getCard(first.id)?.status === "review" && item.board.getCard(mine.id)?.status === "review");
    item.hold();
    await item.pickup.tick();
    assert.equal(item.board.getCard(second.id)?.status, "running", "a freed slot goes to the next card");
  } finally { await item.close(); }
});

test("a rolling six-start limit prevents unbounded model spend and persists after reopening", async () => {
  const item = fixture();
  try {
    item.board.setLimitsEnabled(item.repoBoard.id, true);
    item.release();
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    for (let i = 0; i < 7; i++) item.card(`Task ${i}`);
    // Runs finish at once, so a tick may fill a slot freed while it awaited an earlier start's Git: tick until six.
    for (let ticks = 0; ticks < 6 && item.board.autoStartsToday(item.repo) < 6; ticks++) { await item.pickup.tick(); await waitFor(() => item.board.runningCount(item.repo) === 0); }
    await item.pickup.tick();
    assert.equal(item.board.autoStartsToday(item.repo), 6);
    assert.equal(item.board.listCards(item.repo).filter(card => card.status === "ready").length, 1);
    const capped = item.board.getBoard(item.repoBoard.id)!;
    assert.equal(capped.pickupDailyLimit, 6);
    assert.equal(capped.autoPickupStarts, 6);
    const oldest = item.board.listRuns(item.board.listCards(item.repo).find(card => card.title === "Task 0")!.id)[0].startedAt;
    assert.equal(capped.autoPickupNextAt, new Date(Date.parse(oldest) + 86_400_000).toISOString());
    const second = new Board(join(item.dir, "board.sqlite"));
    assert.equal(second.autoStartsToday(item.repo), 6);
    assert.equal(second.listAutoPickupCandidates().length, 0);
    assert.equal(second.getBoard(item.repoBoard.id)?.autoPickupNextAt, capped.autoPickupNextAt);
    assert.throws(() => second.setAutoPickup(item.repoBoard.id, true, 2, -1), /daily.*limit/i);
    second.setAutoPickup(item.repoBoard.id, true, 2, 0);
    assert.equal(second.getBoard(item.repoBoard.id)?.autoPickupNextAt, null);
    assert.equal(second.listAutoPickupCandidates().length > 0, true);
    second.setAutoPickup(item.repoBoard.id, true, 2, 99);
    assert.equal(second.getBoard(item.repoBoard.id)?.pickupDailyLimit, 99);
    assert.equal(second.listAutoPickupCandidates().length, 1);
    assert.throws(() => second.resetAutoPickupLimit(item.repoBoard.id), /limit|enabled/i);
    assert.throws(() => second.setAutoPickup(item.repoBoard.id, true, 2, 100), /daily.*limit/i);
    second.setAutoPickup(item.repoBoard.id, true, 2, 6);
    second.close();
  } finally { await item.close(); }
});

test("a start in the same millisecond as a reset counts against the new limit", async () => {
  const item = fixture();
  mock.timers.enable({ apis: ["Date"], now: new Date() });
  try {
    item.board.setLimitsEnabled(item.repoBoard.id, true);
    const first = item.card("Before reset"), second = item.card("After reset"), third = item.card("Blocked");
    item.board.setAutoPickup(item.repoBoard.id, true, 2, 1);
    const before = item.board.claim(first.id, "auto");
    item.board.finish(before.id, "review");
    item.board.resetAutoPickupLimit(item.repoBoard.id);
    const after = item.board.claim(second.id, "auto");
    assert.equal(after.startedAt, before.startedAt);
    item.board.finish(after.id, "review");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 1);
    assert.throws(() => item.board.claim(third.id, "auto"), /not eligible/);
  } finally { mock.timers.reset(); await item.close(); }
});

test("an explicit reset clears the rolling count but retains run history and permits another start", async () => {
  const item = fixture();
  try {
    item.board.setLimitsEnabled(item.repoBoard.id, true);
    item.release();
    item.board.setAutoPickup(item.repoBoard.id, true, 2, 1);
    const first = item.card("First"), second = item.card("After reset");
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(first.id)?.status === "review");
    await item.pickup.tick();
    assert.equal(item.board.getCard(second.id)?.status, "ready");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 1);
    assert.throws(() => item.board.resetAutoPickupLimit("missing"), /Board not found/);
    item.board.resetAutoPickupLimit(item.repoBoard.id);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 0);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupNextAt, null);
    assert.equal(item.board.listRuns(first.id).length, 1, "reset does not erase attempts");
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(second.id)?.status === "review");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 1);
  } finally { await item.close(); }
});

test("a second Board connection does not interrupt live runs; explicit server recovery does", async () => {
  const item = fixture();
  try {
    const card = item.card("Active");
    await item.worker.start(card);
    const second = new Board(join(item.dir, "board.sqlite"));
    assert.equal(second.getCard(card.id)?.status, "running");
    item.release();
    await waitFor(() => item.board.getCard(card.id)?.status === "review");
    second.close();
    const afterRestart = new Board(join(item.dir, "board.sqlite"));
    const another = item.card("Interrupted");
    await item.worker.start(another);
    afterRestart.recoverInterruptedRuns(); // Only the exclusive-lock server calls this after startup.
    assert.equal(afterRestart.getCard(another.id)?.status, "interrupted");
    item.release();
    afterRestart.close();
  } finally { await item.close(); }
});

test("a reached daily cost budget makes pickup wait with a reason while manual starts still run", async () => {
  const item = fixture();
  try {
    item.board.setLimitsEnabled(item.repoBoard.id, true);
    const usage = { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, totalTokens: 1260, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 } };
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage } })}' '{"type":"agent_settled","aborted":false}'\n`);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.pickupCostBudget, null, "budget is off by default");
    assert.throws(() => item.board.setAutoPickup(item.repoBoard.id, true, 1, 6, 0), /cost budget/);
    const first = item.card("First"), second = item.card("Second"), manual = item.card("Manual");
    item.board.setAutoPickup(item.repoBoard.id, true, 1, 6, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(first.id)?.status === "review");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.cost24h, 0.6);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(second.id)?.status === "review");
    const capped = item.board.getBoard(item.repoBoard.id)!;
    assert.ok(Math.abs(capped.cost24h - 1.2) < 1e-9);
    assert.equal(capped.autoPickupBudgetReached, true);
    assert.equal(capped.autoPickupEnabled, true, "budget waits like the start limit instead of disabling pickup");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(manual.id).length, 0, "pickup waits at the budget");
    assert.throws(() => item.board.claim(manual.id, "auto"), /not eligible/);
    await item.worker.start(item.board.getCard(manual.id)!);
    await waitFor(() => item.board.getCard(manual.id)?.status === "review");
    item.board.setAutoPickup(item.repoBoard.id, true, 1, 6, null);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupBudgetReached, false, "turning the budget off clears the wait");
  } finally { await item.close(); }
});

test("a refused push at the run limit keeps the hook output and goes to the agent when a slot frees", async () => {
  const item = fixture();
  try {
    const refused = item.card("Refused push"), busy = item.card("Busy");
    await item.worker.start(refused);
    item.release();
    await waitFor(() => item.board.getCard(refused.id)?.status === "review");
    rmSync(join(item.dir, "release"));
    await item.worker.start(busy);
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    item.board.recordPushFailure(refused.id, "abc123", "Unused exports (1)\ncountryCode");
    assert.equal(await item.worker.startHookFix(item.board.getCard(refused.id)!), false, "at the limit the fix waits");
    assert.equal(item.board.getCiFeedback(refused.id)?.source, "push", "the hook output is kept for the waiting run");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(refused.id).length, 1, "still no slot");
    item.release();
    await waitFor(() => item.board.getCard(busy.id)?.status === "review");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(refused.id)[0]?.status, "running");
    assert.equal(item.board.listRuns(refused.id)[0]?.startedBy, "manual", "an operator's Approve asked for it, so it does not count as auto-pickup");
    assert.equal(item.board.getCiFeedback(refused.id), undefined, "the run took the hook output");
  } finally { await item.close(); }
});

test("a reviewer send-back at the run limit is queued and starts with the requested changes when a run finishes", async () => {
  const item = fixture();
  try {
    const reviewerPi = join(item.dir, "fake-reviewer");
    const verdict = '{"verdict":"request_changes","reason":"Missing a test","changes":[{"path":"README.md","comment":"Cover the empty case"}]}';
    writeFileSync(reviewerPi, `#!/bin/sh\ncat <<'EVENTS'\n${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: verdict }] } })}\n{"type":"agent_settled","aborted":false}\nEVENTS\n`); chmodSync(reviewerPi, 0o755);
    const review = new AutoReview(item.board, new Integration(item.board, item.data), reviewerPi, card => item.worker.start(card, "manual", sendBackReason));
    item.board.setAutoReview(item.repoBoard.id, true);
    // Auto-review takes only runs that finish after it was enabled.
    const enabledAt = item.board.getBoard(item.repoBoard.id)!.autoReviewEnabledAt!;
    await waitFor(() => new Date().toISOString() > enabledAt);
    const sent = item.card("Sent back"), busy = item.card("Busy");
    const first = await item.worker.start(sent);
    writeFileSync(join(first.worktree!, "README.md"), "changed\n");
    item.release();
    await waitFor(() => item.board.getCard(sent.id)?.status === "review");
    rmSync(join(item.dir, "release"));
    await item.worker.start(busy);
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await review.tick();
    const queued = item.board.getCard(sent.id)!;
    assert.equal(queued.status, "review");
    assert.equal(item.board.listRuns(sent.id).length, 1, "the run limit kept the new attempt from starting");
    assert.equal(queued.startQueued, true);
    assert.equal(queued.startQueuedForSlot, true, "it waits for a run to finish, not for a restart");
    assert.match(item.board.listCardEvents(sent.id).at(-1)!.reason, /run limit.*starts when a run finishes/);
    await item.pickup.tick();
    assert.equal(item.board.listRuns(sent.id).length, 1, "still no slot");
    item.release();
    await waitFor(() => item.board.getCard(busy.id)?.status === "review");
    await item.pickup.tick();
    const second = item.board.listRuns(sent.id)[0];
    assert.equal(second.attempt, 2);
    assert.equal(second.startedBy, "manual", "the reviewer asked for it, so it does not count as auto-pickup");
    assert.equal(item.board.getCard(sent.id)!.startQueued, false, "the queue entry is used up");
    assert.ok(item.board.listCardEvents(sent.id).some(event => event.reason === `Attempt 2 started ${sendBackReason}`));
    await waitFor(() => item.board.getRun(second.id)?.status === "review");
    const prompts = readFileSync(join(item.dir, "prompts"), "utf8");
    assert.match(prompts.slice(prompts.lastIndexOf(`Task from Alice card ${sent.id}`)), /agent reviewer.*Cover the empty case/);
  } finally { await item.close(); }
});

test("a send-back waiting for a slot outlives a restart replay and is dropped once the card no longer needs it", async () => {
  const item = fixture();
  try {
    const card = item.card("Approved meanwhile");
    item.board.queueStart(card.id, { why: sendBackReason });
    assert.deepEqual(item.board.takeQueuedStarts(), [], "the restart replay never takes a start that waits for a slot");
    assert.equal(item.board.isStartQueued(card.id), true);
    item.board.setStatus(card.id, "done");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(card.id).length, 0);
    assert.equal(item.board.isStartQueued(card.id), false);
  } finally { await item.close(); }
});

test("any run that claims the card uses up its queued send-back, so pickup never starts a second one", async () => {
  const item = fixture();
  try {
    const card = item.card("Started by hand");
    item.board.queueStart(card.id, { why: sendBackReason });
    const manual = await item.worker.start(item.board.getCard(card.id)!);
    assert.equal(item.board.isStartQueued(card.id), false, "the claim consumed the queued start");
    item.release();
    await waitFor(() => item.board.getRun(manual.id)?.status === "review");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(card.id).length, 1, "pickup started nothing further");
    item.board.queueStart(card.id, { why: sendBackReason });
    item.board.finish(item.board.claim(card.id).id, "failed", "Rebase conflicted");
    await item.pickup.tick();
    assert.equal(item.board.listRuns(card.id).length, 2, "a failed attempt used it up too");
    assert.equal(item.board.isStartQueued(card.id), false);
  } finally { await item.close(); }
});

const providerFailurePi = (
  item: ReturnType<typeof fixture>,
  errorMessage: string,
) =>
  writeFileSync(
    join(item.dir, "fake-pi"),
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage } })}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`,
  );
const DNS = "cannot resolve tunnel destination api.anthropic.com (ETIMEDOUT)";
/** Pretends the card's backoff has run out. */
const expireBackoff = (item: ReturnType<typeof fixture>, id: string) => {
  const db = new DatabaseSync(join(item.dir, "board.sqlite"));
  try {
    db.prepare("UPDATE cards SET autoRetryAt=? WHERE id=?").run(
      new Date(Date.now() - 1000).toISOString(),
      id,
    );
  } finally {
    db.close();
  }
};

test("a temporary provider failure returns the card to Ready, retries after a backoff, and pickup keeps running", async () => {
  const item = fixture();
  try {
    providerFailurePi(item, DNS);
    const flaky = item.card("Flaky network");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.listRuns(flaky.id)[0]?.status === "failed");
    let card = item.board.getCard(flaky.id)!;
    assert.equal(card.status, "ready");
    assert.equal(card.autoRetries, 1);
    const wait = Date.parse(card.autoRetryAt!) - Date.now();
    assert.ok(
      wait > 50_000 && wait <= 60_000,
      `first retry waits 1 minute, got ${wait}ms`,
    );
    assert.equal(item.board.listRuns(flaky.id)[0].failureKind, "transient");
    await item.pickup.tick();
    assert.equal(
      item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled,
      true,
      "pickup is not paused",
    );
    assert.equal(
      item.board.listRuns(flaky.id).length,
      1,
      "the card waits out its backoff",
    );
    assert.throws(() => item.board.claim(flaky.id, "auto"), /not eligible/);
    // The network recovers, and the backoff passes.
    writeFileSync(
      join(item.dir, "fake-pi"),
      `#!/bin/sh\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`,
    );
    expireBackoff(item, flaky.id);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(flaky.id)?.status === "review");
    card = item.board.getCard(flaky.id)!;
    assert.equal(item.board.listRuns(flaky.id).length, 2);
    assert.equal(
      card.autoRetries,
      0,
      "a successful run clears the retry count",
    );
    assert.equal(card.autoRetryAt, null);
    assert.equal(
      item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled,
      true,
    );
  } finally {
    await item.close();
  }
});

test("a temporary provider failure retries after 1, 5 and 15 minutes, then the fourth failure pauses pickup", async () => {
  const item = fixture();
  try {
    providerFailurePi(item, "Rate limited: 429 rate_limit_error");
    const stuck = item.card("Never recovers");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    const minutes: number[] = [];
    for (let round = 1; round <= 3; round++) {
      await item.pickup.tick();
      await waitFor(
        () =>
          item.board.listRuns(stuck.id).length === round &&
          item.board.getCard(stuck.id)?.status === "ready",
      );
      const card = item.board.getCard(stuck.id)!;
      assert.equal(card.autoRetries, round);
      minutes.push(
        Math.round((Date.parse(card.autoRetryAt!) - Date.now()) / 60_000),
      );
      await item.pickup.tick();
      assert.equal(
        item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled,
        true,
      );
      expireBackoff(item, stuck.id);
    }
    assert.deepEqual(minutes, [1, 5, 15]);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(stuck.id)?.status === "failed");
    assert.equal(item.board.listRuns(stuck.id).length, 4);
    const waiting = item.card("Waiting");
    await item.pickup.tick();
    assert.equal(
      item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled,
      true,
    );
    assert.equal(item.board.listRuns(waiting.id).length, 1, "the next card starts");
    assert.equal(item.board.listRuns(stuck.id).length, 4, "the failed card is not restarted");
    assert.match(
      item.board.listCardEvents(stuck.id).at(-1)!.reason,
      /after 3 automatic retries/,
    );
  } finally {
    await item.close();
  }
});

test("an HTTP 502 from the provider proxy schedules one retry, records it on the run, and explains it on the card", async () => {
  const item = fixture();
  try {
    providerFailurePi(item, '502 {"error":"acp-proxy failure: upstream-timeout ETIMEDOUT api.anthropic.com","detail":"Error: upstream request failed: kind=upstream-timeout code=ETIMEDOUT message=fetch failed"}');
    const flaky = item.card("Proxy hiccup");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.listRuns(flaky.id)[0]?.status === "failed");
    const [run] = item.board.listRuns(flaky.id);
    assert.match(run.error ?? "", /^Provider request failed \(HTTP 502\)/);
    assert.equal(run.failureKind, "transient");
    assert.equal(run.retryScheduled, 1);
    const card = item.board.getCard(flaky.id)!;
    assert.equal(card.status, "ready");
    assert.equal(card.autoRetries, 1);
    assert.ok(card.autoRetryAt);
    assert.match(item.board.listCardEvents(flaky.id).at(-1)!.reason, /automatic retry 1 of 3/);
    await item.pickup.tick();
    assert.equal(item.board.listRuns(flaky.id).length, 1, "only one retry is queued, and it waits for its backoff");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, true);
  } finally {
    await item.close();
  }
});

test("a provider failure with no explanation is not retried", async () => {
  const item = fixture();
  try {
    providerFailurePi(item, "");
    const unexplained = item.card("No detail"), waiting = item.card("Waiting");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(unexplained.id)?.status === "failed");
    const [run] = item.board.listRuns(unexplained.id);
    assert.equal(run.failureKind, "unknown");
    assert.equal(run.retryScheduled, 0);
    const card = item.board.getCard(unexplained.id)!;
    assert.equal(card.autoRetries, 0);
    assert.equal(card.autoRetryAt, null);
    await item.pickup.tick();
    assert.equal(item.board.getCard(unexplained.id)?.status, "failed", "the card stays Failed");
    assert.equal(item.board.listRuns(unexplained.id).length, 1, "and is not restarted");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, true);
    assert.equal(item.board.listRuns(waiting.id).length, 1, "the next card starts");
  } finally {
    await item.close();
  }
});

test("an authentication failure pauses pickup at once without a retry, since every card would fail", async () => {
  const item = fixture();
  try {
    providerFailurePi(
      item,
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    );
    const rejected = item.card("Bad key"),
      waiting = item.card("Waiting");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.getCard(rejected.id)?.status === "failed");
    const card = item.board.getCard(rejected.id)!;
    assert.equal(card.autoRetries, 0);
    assert.equal(card.autoRetryAt, null);
    assert.equal(item.board.listRuns(rejected.id)[0].retryScheduled, 0);
    await item.pickup.tick();
    assert.equal(
      item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled,
      false,
    );
    assert.equal(item.board.listRuns(waiting.id).length, 0);
    assert.match(item.board.getBoard(item.repoBoard.id)?.autoPickupError ?? "", /authentication or billing/);
    // Turning pickup back on starts the next card; the old refusal does not pause it again.
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, true);
    assert.equal(item.board.listRuns(waiting.id).length, 1);
  } finally {
    await item.close();
  }
});

test("an automatic run the operator stops after a temporary provider error is not retried, and pickup carries on", async () => {
  const item = fixture();
  try {
    const event = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate_limit_error" } });
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf '%s\\n' '${event}'\nexec sleep 30\n`);
    const stopped = item.card("Stopped"), waiting = item.card("Waiting");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    await item.pickup.tick();
    await waitFor(() => item.board.listRuns(stopped.id)[0]?.output.includes("Provider request failed") === true);
    item.worker.stop(item.board.listRuns(stopped.id)[0].id);
    await waitFor(() => item.board.getCard(stopped.id)?.status === "failed");
    const card = item.board.getCard(stopped.id)!;
    assert.equal(card.autoRetries, 0);
    assert.equal(card.autoRetryAt, null);
    assert.equal(item.board.listRuns(stopped.id)[0].retryScheduled, 0);
    await item.pickup.tick();
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, true);
    assert.equal(item.board.listRuns(waiting.id).length, 1);
  } finally { await item.close(); }
});

test("a restart drain that begins while a start prepares its Git leaves pickup on", async () => {
  const item = fixture();
  try {
    const card = item.card("Waiting");
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    // The tick reaches the start's first Git call before returning, so the drain lands before the claim.
    const ticking = item.pickup.tick();
    item.worker.stopStarts();
    await ticking;
    assert.equal(item.board.listRuns(card.id).length, 0, "nothing was claimed");
    assert.equal(item.board.getCard(card.id)?.status, "ready");
    const after = item.board.getBoard(item.repoBoard.id)!;
    assert.equal(after.autoPickupEnabled, true, "a drain is not a reason to turn pickup off");
    assert.equal(after.autoPickupError, "");
  } finally { await item.close(); }
});

test("a card moved out of Ready while its start prepares Git does not pause pickup", async () => {
  const item = fixture();
  try {
    const card = item.card("Moved");
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    const ticking = item.pickup.tick();
    item.board.setStatus(card.id, "triage");
    await ticking;
    assert.equal(item.board.listRuns(card.id).length, 0);
    assert.equal(item.board.getBoard(item.repoBoard.id)!.autoPickupEnabled, true);
  } finally { await item.close(); }
});
