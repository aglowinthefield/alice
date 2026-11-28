import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("a Failed card's tile shows why it failed", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = (id: string, status: string, failureSummary: string | null) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", failureSummary });
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card("broken", "failed", "Timed out after 60 min"), card("fine", "ready", null)],
      "/api/boards/board/conflicts": [],
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const broken = page.locator('section[data-status="failed"]').getByRole("button", { name: /broken card/ });
    await broken.waitFor();
    assert.equal((await broken.getByTestId("failure-summary").textContent())?.trim(), "Timed out after 60 min");
    assert.equal(await page.getByTestId("failure-summary").count(), 1);
  } finally {
    await browser.close();
    await server.close();
  }
});
