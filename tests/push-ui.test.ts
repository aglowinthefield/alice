import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

// The browser half of Web Push. The push service itself is out of reach in a test, so the service worker container
// and push manager are stand-ins; the subscription Bakery saves and the card a clicked notification opens are real.
test("Settings subscribes this browser to push notifications, and a clicked notification opens its card", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const requests: { method: string; body: unknown }[] = [];
  try {
    // A string, not a function: tsx would add helpers the page does not have.
    await page.addInitScript(`
      let current = null;
      const sub = { endpoint: "https://push.example/browser", toJSON: () => ({ endpoint: "https://push.example/browser", keys: { p256dh: "BPub", auth: "auth" } }), unsubscribe: async () => { current = null; return true; } };
      const registration = { pushManager: { getSubscription: async () => current, subscribe: async () => (current = sub) } };
      const container = Object.assign(new EventTarget(), { register: async () => registration, getRegistration: async () => registration, ready: Promise.resolve(registration) });
      Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => container, configurable: true });
      window.Notification = class { static permission = "default"; static async requestPermission() { return "granted"; } };
      window.swContainer = container;
    `);
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method();
      if (path === "/api/push/key") return route.fulfill({ json: { publicKey: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM" } });
      if (path === "/api/push/subscriptions") { requests.push({ method, body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }); }
      const data: Record<string, unknown> = {
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/boards/board/cards": [{ id: "c1", title: "Waiting card", body: "", repo: "/tmp/repo", source: "manual", status: "review", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 }],
        "/api/boards/board/conflicts": [],
        "/api/status": { draining: false, activeRuns: 0 },
        "/api/boards/board/cards/c1/approval": { pending: false },
        "/api/boards/board/cards/c1/push-progress": null,
        "/api/boards/board/cards/c1/review": { fingerprint: "a".repeat(64), files: [] },
      };
      // Anything else the card dialog lists (runs, comments, history) is empty.
      await route.fulfill({ json: path in data ? data[path] : [] });
    });
    await page.goto(new URL("/settings/general", server.resolvedUrls!.local[0]).href);
    const toggle = page.getByTestId("push-notifications");
    await page.waitForFunction(() => !(document.querySelector('[data-testid="push-notifications"]') as HTMLInputElement | null)?.disabled);
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="push-notifications"]') as HTMLInputElement).checked);
    assert.deepEqual(requests, [{ method: "POST", body: { endpoint: "https://push.example/browser", keys: { p256dh: "BPub", auth: "auth" } } }]);

    // The service worker posts this to an open tab when its notification is clicked.
    await page.evaluate(() => (window as unknown as { swContainer: EventTarget }).swContainer.dispatchEvent(new MessageEvent("message", { data: { type: "open", url: "/board/board/card/c1" } })));
    await page.getByRole("dialog").getByText("Waiting card").first().waitFor();
    assert.equal(new URL(page.url()).pathname, "/board/board/card/c1");

    await page.evaluate(() => { history.pushState(null, "", "/settings/general"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForFunction(() => (document.querySelector('[data-testid="push-notifications"]') as HTMLInputElement | null)?.checked === true);
    await page.getByTestId("push-notifications").click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="push-notifications"]') as HTMLInputElement).checked === false);
    assert.deepEqual(requests.at(-1), { method: "DELETE", body: { endpoint: "https://push.example/browser" } });
  } finally {
    await browser.close();
    await server.close();
  }
});
