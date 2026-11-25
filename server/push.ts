import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { generateVAPIDKeys, sendNotification } from "web-push";
import { reviewActionLabels, type Board, type Card } from "./board.js";

// Web Push: browsers that turned notifications on in Settings get one when a card becomes your turn (in Review, with
// nothing else, such as the agent reviewer or GitHub CI, still holding it) or fails, even with no Bakery tab open.
// A timer compares the cards against the set it last saw, which is stored, so a restart neither repeats nor drops
// notifications and turning them on does not replay cards that already needed you.

export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };
export type Notice = { title: string; body: string; tag: string; url: string };
type Kind = "turn" | "failed";
/** Sends one notice to one subscription; rejects with a `statusCode` of 404 or 410 when the subscription is gone. */
export type Send = (subscription: PushSubscriptionInput, notice: Notice, keys: VapidKeys) => Promise<void>;
export type VapidKeys = { publicKey: string; privateKey: string };

// Push services ask for a contact; Bakery has no operator address, so this names the project.
const subject = "https://github.com/aglowinthefield/bakery";
const sendWebPush: Send = async (subscription, notice, keys) => {
  await sendNotification(subscription, JSON.stringify(notice), { vapidDetails: { subject, ...keys }, TTL: 24 * 60 * 60, urgency: "high" });
};

export class PushNotifications {
  private timer: ReturnType<typeof setInterval> | undefined;
  private keys: VapidKeys | undefined;

  constructor(private board: Board, private db: DatabaseSync, private dataDir: string, private send: Send = sendWebPush) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_seen (cardId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('turn','failed')), PRIMARY KEY (cardId, kind));
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

  /** Notifies every subscription about cards that became your turn or failed since the last tick. */
  async tick(): Promise<void> {
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
    const subscriptions = this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as { endpoint: string; p256dh: string; auth: string }[];
    if (!fresh.length || !subscriptions.length) return;
    const keys = this.vapid();
    for (const { card, kind } of fresh) {
      const notice = this.notice(card, kind);
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

function parseSubscription(input: unknown): PushSubscriptionInput {
  const value = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = value?.endpoint, p256dh = value?.keys?.p256dh, auth = value?.keys?.auth;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 2000) throw new Error("A push subscription needs an https endpoint");
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) throw new Error("A push subscription needs its p256dh and auth keys");
  return { endpoint, keys: { p256dh, auth } };
}
