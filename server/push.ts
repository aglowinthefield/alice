import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { generateVAPIDKeys, sendNotification } from "web-push";
import { isSentinelJob, reviewActionLabels, type Board, type Card } from "./board.js";
import { isStaleReview, reviewAgeDays } from "../src/stale-review.js";

// Web Push: browsers that turned notifications on in Settings get one when a card becomes your turn (in Review, with
// nothing else, such as the agent reviewer or GitHub CI, still holding it) or fails, even with no Bakery tab open.
// A timer compares the cards against the set it last saw, which is stored, so a restart neither repeats nor drops
// notifications and turning them on does not replay cards that already needed you.
// Once a day at most, and only when some Review card has gone stale (see src/stale-review.ts), one digest lists the
// stale cards and opens Today, where each has Approve, Run again on current main and Close.

export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };
export type Notice = { title: string; body: string; tag: string; url: string };
type Kind = "turn" | "failed";
/** Sends one notice to one subscription; rejects with a `statusCode` of 404 or 410 when the subscription is gone. */
export type Send = (subscription: PushSubscriptionInput, notice: Notice, keys: VapidKeys) => Promise<void>;
export type VapidKeys = { publicKey: string; privateKey: string };
/** The digest goes out at most once in this window. */
export const digestIntervalMs = 24 * 60 * 60_000;

// Push services ask for a contact; Bakery has no operator address, so this names the project.
const subject = "https://github.com/aglowinthefield/bakery";
const sendWebPush: Send = async (subscription, notice, keys) => {
  await sendNotification(subscription, JSON.stringify(notice), { vapidDetails: { subject, ...keys }, TTL: 24 * 60 * 60, urgency: "high" });
};

export class PushNotifications {
  private timer: ReturnType<typeof setInterval> | undefined;
  private keys: VapidKeys | undefined;

  constructor(private board: Board, private db: DatabaseSync, private dataDir: string, private send: Send = sendWebPush, private clock: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_seen (cardId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('turn','failed')), PRIMARY KEY (cardId, kind));
      CREATE TABLE IF NOT EXISTS push_digest (id INTEGER PRIMARY KEY CHECK(id=1), sentAt TEXT NOT NULL);
    `);
  }

  /** The server's VAPID public key, made on first use and kept in the data directory. Browsers subscribe with it. */
  publicKey(): string { return this.vapid().publicKey; }

  subscribe(input: unknown): void {
    const subscription = parseSubscription(input);
    this.db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth")
      .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, new Date().toISOString());
  }

  unsubscribe(endpoint: unknown): void {
    if (typeof endpoint !== "string") throw new Error("endpoint is required");
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint);
  }

  start(intervalMs = 10_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** Notifies every subscription about cards that became your turn or failed since the last tick, then sends the stale digest when due. */
  async tick(): Promise<void> {
    await this.notifyChanges();
    await this.digest();
  }

  /** Review cards past their board's stale threshold, oldest first. */
  staleCards(now = this.clock()): Card[] {
    const stale: Card[] = [];
    for (const repoBoard of this.board.listBoards())
      for (const card of this.board.listCards(repoBoard.repo))
        if (!isSentinelJob(card) && isStaleReview(card, repoBoard.staleReviewDays, now)) stale.push(card);
    return stale.sort((a, b) => (a.reviewSince ?? "").localeCompare(b.reviewSince ?? ""));
  }

  /**
   * Sends one digest of stale Review cards when some are stale and none went out in the last 24 hours. The send time
   * is stored before sending, so a restart or a failing push service never sends a second one the same day.
   */
  async digest(): Promise<void> {
    const now = this.clock();
    const last = this.db.prepare("SELECT sentAt FROM push_digest WHERE id=1").get() as { sentAt: string } | undefined;
    if (last && now - Date.parse(last.sentAt) < digestIntervalMs) return;
    const stale = this.staleCards(now);
    const subscriptions = this.subscriptions();
    if (!stale.length || !subscriptions.length) return;
    this.db.prepare("INSERT INTO push_digest (id, sentAt) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET sentAt=excluded.sentAt").run(new Date(now).toISOString());
    await this.deliver(subscriptions, digestNotice(stale, now));
  }

  private subscriptions() {
    return this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as { endpoint: string; p256dh: string; auth: string }[];
  }

  private async deliver(subscriptions: { endpoint: string; p256dh: string; auth: string }[], notice: Notice): Promise<void> {
    const keys = this.vapid();
    await Promise.all(subscriptions.map(async row => {
      try { await this.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, notice, keys); }
      catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // The browser unsubscribed or the push service expired it; it will not come back.
        if (status === 404 || status === 410) this.unsubscribe(row.endpoint);
        else console.warn(`Push notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  private async notifyChanges(): Promise<void> {
    const now = new Map<string, { card: Card; kind: Kind }>();
    for (const repoBoard of this.board.listBoards()) {
      for (const card of this.board.listCards(repoBoard.repo)) {
        const kind = card.status === "failed" ? "failed" : card.status === "review" && !card.reviewWait ? "turn" : null;
        if (kind) now.set(`${card.id}\t${kind}`, { card, kind });
      }
    }
    const seen = new Set((this.db.prepare("SELECT cardId, kind FROM push_seen").all() as { cardId: string; kind: Kind }[]).map(row => `${row.cardId}\t${row.kind}`));
    const fresh = [...now].filter(([key]) => !seen.has(key)).map(([, item]) => item);
    this.db.exec("BEGIN");
    try {
      for (const key of seen) if (!now.has(key)) { const [cardId, kind] = key.split("\t"); this.db.prepare("DELETE FROM push_seen WHERE cardId=? AND kind=?").run(cardId, kind); }
      for (const { card, kind } of fresh) this.db.prepare("INSERT INTO push_seen (cardId, kind) VALUES (?, ?)").run(card.id, kind);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const subscriptions = this.subscriptions();
    if (!fresh.length || !subscriptions.length) return;
    for (const { card, kind } of fresh) await this.deliver(subscriptions, this.notice(card, kind));
  }

  private notice(card: Card, kind: Kind): Notice {
    const boardId = this.board.boardForRepo(card.repo)?.id;
    const url = boardId ? `/board/${encodeURIComponent(boardId)}/card/${encodeURIComponent(card.id)}` : "/";
    const repo = basename(card.repo);
    if (kind === "failed") return { title: `Failed: ${card.title}`.slice(0, 120), body: `${repo} · ${card.failureSummary ?? "The run failed"}`.slice(0, 240), tag: `failed-${card.id}`, url };
    const action = card.reviewAction ? reviewActionLabels[card.reviewAction] : "Ready for your review";
    return { title: `Your turn: ${card.title}`.slice(0, 120), body: `${repo} · ${action}`, tag: `turn-${card.id}`, url };
  }

  private vapid(): VapidKeys {
    if (this.keys) return this.keys;
    const path = join(this.dataDir, "push-vapid.json");
    if (existsSync(path)) this.keys = JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
    else {
      this.keys = generateVAPIDKeys();
      writeFileSync(path, JSON.stringify(this.keys), { mode: 0o600 });
    }
    return this.keys;
  }
}

/** One notice for every stale card: the count, then the oldest few with their repo and days in Review. */
export function digestNotice(stale: Card[], now: number): Notice {
  const shown = 4;
  const lines = stale.slice(0, shown).map(card => `${basename(card.repo)} · ${card.title.slice(0, 60)} (${reviewAgeDays(card, now) ?? 0}d)`);
  if (stale.length > shown) lines.push(`and ${stale.length - shown} more`);
  const count = `${stale.length} ${stale.length === 1 ? "card has" : "cards have"}`;
  return { title: `${count} sat in Review too long`, body: lines.join("\n").slice(0, 400), tag: "stale-review-digest", url: "/today" };
}

function parseSubscription(input: unknown): PushSubscriptionInput {
  const value = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = value?.endpoint, p256dh = value?.keys?.p256dh, auth = value?.keys?.auth;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 2000) throw new Error("A push subscription needs an https endpoint");
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) throw new Error("A push subscription needs its p256dh and auth keys");
  return { endpoint, keys: { p256dh, auth } };
}
