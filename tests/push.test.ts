import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Board } from "../server/board.js";
import { PushNotifications, type Notice, type Send } from "../server/push.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alice-push-")), repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hi\n");
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  board.setAutoReview(repoBoard.id, false);
  const sent: { endpoint: string; notice: Notice }[] = [];
  let failWith: number | null = null;
  const send: Send = async (subscription, notice) => {
    if (failWith) throw Object.assign(new Error("gone"), { statusCode: failWith });
    sent.push({ endpoint: subscription.endpoint, notice });
  };
  const push = new PushNotifications(board, board.sqlite, dir, send);
  const finish = (title: string, status: "review" | "failed") => {
    const card = board.createCard({ repo, title, body: "" });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id);
    board.finish(run.id, status, status === "failed" ? "boom" : undefined);
    return card;
  };
  return { dir, board, repoBoard, push, sent, finish, failWith: (status: number | null) => { failWith = status; }, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: "BPub", auth: "auth" } });

test("a card that becomes your turn or fails notifies every subscribed browser once, with a link to the card", async () => {
  const f = fixture();
  try {
    f.push.subscribe(subscription("https://push.example/a"));
    f.push.subscribe(subscription("https://push.example/b"));
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    const review = f.finish("Add a greeting", "review");
    const failed = f.finish("Break the build", "failed");
    await f.push.tick();
    assert.equal(f.sent.length, 4);
    const turn = f.sent.find(item => item.endpoint === "https://push.example/a" && item.notice.tag === `turn-${review.id}`)!.notice;
    assert.equal(turn.title, "Your turn: Add a greeting");
    assert.equal(turn.url, `/board/${f.repoBoard.id}/card/${review.id}`);
    assert.match(f.sent.find(item => item.notice.tag === `failed-${failed.id}`)!.notice.title, /^Failed: Break the build/);
    await f.push.tick();
    assert.equal(f.sent.length, 4, "nothing new, nothing sent");
  } finally { f.close(); }
});

test("cards that needed you before notifications were on, or before a restart, are not sent again", async () => {
  const f = fixture();
  try {
    f.finish("Already waiting", "review");
    await f.push.tick();
    f.push.subscribe(subscription("https://push.example/a"));
    await f.push.tick();
    assert.equal(f.sent.length, 0, "turning notifications on does not replay old cards");
    const restarted = new PushNotifications(f.board, f.board.sqlite, f.dir, async (_s, notice) => { f.sent.push({ endpoint: "restarted", notice }); });
    await restarted.tick();
    assert.equal(f.sent.length, 0);
    f.finish("New one", "review");
    await restarted.tick();
    assert.deepEqual(f.sent.map(item => item.notice.title), ["Your turn: New one"]);
  } finally { f.close(); }
});

test("a Review card the agent reviewer still has notifies only once it is handed to you", async () => {
  const f = fixture();
  try {
    f.push.subscribe(subscription("https://push.example/a"));
    f.board.setAutoReview(f.repoBoard.id, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const card = f.finish("Reviewed by an agent", "review");
    assert.ok(f.board.getCard(card.id)!.reviewWait, "the agent reviewer has it");
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    f.board.setAutoReview(f.repoBoard.id, false);
    assert.equal(f.board.getCard(card.id)!.reviewWait, null);
    await f.push.tick();
    assert.deepEqual(f.sent.map(item => item.notice.tag), [`turn-${card.id}`]);
  } finally { f.close(); }
});

test("a card that leaves Review and comes back notifies again", async () => {
  const f = fixture();
  try {
    f.push.subscribe(subscription("https://push.example/a"));
    const card = f.finish("Round trip", "review");
    await f.push.tick();
    f.board.setStatus(card.id, "ready");
    await f.push.tick();
    const run = f.board.claim(card.id);
    f.board.finish(run.id, "review");
    await f.push.tick();
    assert.deepEqual(f.sent.map(item => item.notice.tag), [`turn-${card.id}`, `turn-${card.id}`]);
  } finally { f.close(); }
});

test("a subscription the push service reports gone is dropped; unsubscribing stops notices", async () => {
  const f = fixture();
  try {
    f.push.subscribe(subscription("https://push.example/gone"));
    f.failWith(410);
    f.finish("First", "review");
    await f.push.tick();
    f.failWith(null);
    f.finish("Second", "review");
    await f.push.tick();
    assert.equal(f.sent.length, 0, "the gone subscription was removed");
    f.push.subscribe(subscription("https://push.example/a"));
    f.push.unsubscribe("https://push.example/a");
    f.finish("Third", "review");
    await f.push.tick();
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test("subscriptions must be https push endpoints with keys; the VAPID key pair is kept private on disk", () => {
  const f = fixture();
  try {
    assert.throws(() => f.push.subscribe({ endpoint: "http://push.example/a", keys: { p256dh: "x", auth: "y" } }), /https endpoint/);
    assert.throws(() => f.push.subscribe({ endpoint: "https://push.example/a" }), /p256dh and auth/);
    const key = f.push.publicKey();
    assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(new PushNotifications(f.board, f.board.sqlite, f.dir).publicKey(), key, "the same key after a restart");
    const file = join(f.dir, "push-vapid.json");
    assert.ok(existsSync(file));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test("the stale Review digest goes out at most once a day, and only when a card is stale", async () => {
  const day = 24 * 60 * 60_000;
  let clock = Date.now();
  const f = fixture();
  try {
    const push = new PushNotifications(f.board, f.board.sqlite, f.dir, async (subscription, notice) => { f.sent.push({ endpoint: subscription.endpoint, notice }); }, () => clock);
    const digests = () => f.sent.filter(item => item.notice.tag === "stale-review-digest");
    const old = f.finish("Old work", "review");
    clock = Date.parse(f.board.getCard(old.id)!.reviewSince!) + 4 * day;
    await push.tick();
    assert.equal(digests().length, 0, "nobody subscribed, so nothing is sent or counted as sent");
    push.subscribe(subscription("https://push.example/a"));
    clock -= 3 * day;
    await push.tick();
    assert.equal(digests().length, 0, "a 1-day-old Review card is not stale");
    clock += 3 * day;
    await push.tick();
    assert.equal(digests().length, 1);
    const notice = digests()[0].notice;
    assert.equal(notice.title, "1 card has sat in Review too long");
    assert.match(notice.body, /repo · Old work \(4d\)/);
    assert.equal(notice.url, "/today");
    clock += 23 * 60 * 60_000;
    await push.tick();
    assert.equal(digests().length, 1, "not twice within a day");
    const restarted = new PushNotifications(f.board, f.board.sqlite, f.dir, async (subscription, item) => { f.sent.push({ endpoint: subscription.endpoint, notice: item }); }, () => clock);
    await restarted.tick();
    assert.equal(digests().length, 1, "a restart does not resend today's digest");
    clock += 60 * 60_000;
    await push.tick();
    assert.equal(digests().length, 2, "the next day it goes out again while the card is still stale");
    f.board.closeReview(old.id);
    clock += 2 * day;
    await push.tick();
    assert.equal(digests().length, 2, "nothing stale, nothing sent");
  } finally { f.close(); }
});

test("the digest follows each board's threshold and lists the oldest cards first", async () => {
  const day = 24 * 60 * 60_000;
  let clock = Date.now();
  const f = fixture();
  try {
    const push = new PushNotifications(f.board, f.board.sqlite, f.dir, async (subscription, notice) => { f.sent.push({ endpoint: subscription.endpoint, notice }); }, () => clock);
    push.subscribe(subscription("https://push.example/a"));
    f.finish("First", "review");
    f.finish("Second", "review");
    f.board.setStaleReviewDays(f.repoBoard.id, 5);
    clock += 4 * day;
    assert.equal(push.staleCards().length, 0, "4 days is not stale on a 5-day board");
    f.board.setStaleReviewDays(f.repoBoard.id, 0);
    clock += 30 * day;
    assert.equal(push.staleCards().length, 0, "0 turns it off");
    f.board.setStaleReviewDays(f.repoBoard.id, 3);
    assert.deepEqual(push.staleCards().map(card => card.title), ["First", "Second"]);
    await push.tick();
    assert.equal(f.sent.filter(item => item.notice.tag === "stale-review-digest")[0].notice.title, "2 cards have sat in Review too long");
  } finally { f.close(); }
});

test("a running card that may be stuck notifies once, naming why", async () => {
  const f = fixture();
  try {
    f.push.subscribe(subscription("https://push.example/a"));
    const card = f.board.createCard({ repo: f.repoBoard.repo, title: "Rerun the tests", body: "" });
    f.board.setStatus(card.id, "ready");
    const run = f.board.claim(card.id);
    await f.push.tick();
    assert.equal(f.sent.length, 0, "a running card that looks fine is quiet");
    f.board.markStuck(run.id, "repeated the same bash call 5 times in its last 20 tool calls");
    await f.push.tick();
    await f.push.tick();
    assert.deepEqual(f.sent.map(item => item.notice), [{
      title: "May be stuck: Rerun the tests",
      body: "repo · The run repeated the same bash call 5 times in its last 20 tool calls",
      tag: `stuck-${card.id}`,
      url: `/board/${f.repoBoard.id}/card/${card.id}`,
    }]);
  } finally { f.close(); }
});

test("an older push_seen table that rejects 'stuck' is rebuilt and keeps what it had seen", async () => {
  const f = fixture();
  try {
    const db = f.board.sqlite;
    db.exec("DROP TABLE push_seen; CREATE TABLE push_seen (cardId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('turn','failed')), PRIMARY KEY (cardId, kind)); INSERT INTO push_seen VALUES ('old', 'turn');");
    new PushNotifications(f.board, db, f.dir, async () => {});
    db.prepare("INSERT INTO push_seen (cardId, kind) VALUES ('new', 'stuck')").run();
    assert.deepEqual(db.prepare("SELECT cardId, kind FROM push_seen ORDER BY cardId").all().map(row => ({ ...row })), [{ cardId: "new", kind: "stuck" }, { cardId: "old", kind: "turn" }]);
  } finally { f.close(); }
});
