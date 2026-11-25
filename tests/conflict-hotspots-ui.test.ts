import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

const hotspot = (file: string, cards: number) => ({ file, cards, cardIds: [], lastAt: "2026-01-02T00:00:00.000Z" });

test("a file that keeps conflicting gets a board notice with fixes, and Dismiss hides it", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    let hotspots = [hotspot("docs/agent-map/api.md", 4), hotspot("config/allowlist.txt", 3)];
    const dismissed: unknown[] = [];
    const theme = process.env.BAKERY_HOTSPOT_THEME ?? "default";
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/status") return route.fulfill({ json: { draining: false, activeRuns: 0 } });
      if (path === "/api/boards/board/conflict-hotspots/dismiss") {
        const { file } = route.request().postDataJSON() as { file: string };
        dismissed.push(file);
        hotspots = hotspots.filter(item => item.file !== file);
        return route.fulfill({ json: { ok: true } });
      }
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false, conflictHotspots: hotspots }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme },
        "/api/boards/board/cards": [],
        "/api/boards/board/conflicts": [],
      };
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const notice = page.getByRole("status", { name: "Conflict hint for docs/agent-map/api.md" });
    await notice.waitFor();
    const text = await notice.innerText();
    assert.match(text, /docs\/agent-map\/api\.md conflicted on 4 cards in the last 14 days/);
    assert.match(text, /docs\/agent-map\/api\.md merge=union/);
    assert.match(text, /Generate it/);
    assert.match(text, /depend on each other/);
    assert.equal(await page.getByTestId("conflict-hotspot").count(), 2);
    if (process.env.BAKERY_HOTSPOT_SCREENSHOT) await page.screenshot({ path: process.env.BAKERY_HOTSPOT_SCREENSHOT });

    await page.getByRole("button", { name: "Dismiss conflict hint for docs/agent-map/api.md" }).click();
    await notice.waitFor({ state: "detached" });
    assert.deepEqual(dismissed, ["docs/agent-map/api.md"]);
    await page.getByRole("status", { name: "Conflict hint for config/allowlist.txt" }).waitFor();
    assert.equal(await page.getByTestId("conflict-hotspot").count(), 1);
  } finally {
    await browser.close();
    await server.close();
  }
});
