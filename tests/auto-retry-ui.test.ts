import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("a card waiting out an automatic retry shows the retry count and when it runs next", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const at = new Date(Date.now() + 60_000).toISOString();
    const card = (id: string, autoRetries: number, autoRetryAt: string | null) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status: "ready",
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", autoRetries, autoRetryAt });
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card("flaky", 1, at), card("steady", 0, null)],
      "/api/boards/board/conflicts": [],
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const ready = page.locator('section[data-status="ready"]');
    const flaky = ready.getByRole("button", { name: /flaky card/ });
    await flaky.waitFor();
    const time = await page.evaluate(iso => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), at);
    assert.equal((await flaky.getByTestId("auto-retry").textContent())?.trim(), `Retry 1/3 · next ${time}`);
    assert.equal(await ready.getByRole("button", { name: /steady card/ }).getByTestId("auto-retry").count(), 0, "no badge without a retry");
    if (process.env.AUTO_RETRY_SCREENSHOT) await flaky.screenshot({ path: process.env.AUTO_RETRY_SCREENSHOT });
  } finally {
    await browser.close();
    await server.close();
  }
});
