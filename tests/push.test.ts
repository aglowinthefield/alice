import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Board } from "../server/board.js";
import { PushNotifications, type Notice, type Send } from "../server/push.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-push-")), repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hi\n");
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
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
    f.board.setAutoReview(f.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const card = f.finish("Reviewed by an agent", "review");
    assert.ok(f.board.getCard(card.id)!.reviewWait, "the agent reviewer has it");
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    f.board.setAutoReview(f.repoBoard.id, false, "true");
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
