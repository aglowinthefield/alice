import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

const hotspot = (file: string, cards: number) => ({ file, cards, cardIds: [], lastAt: "2026-01-02T00:00:00.000Z" });

test("files that keep conflicting get board notices with fixes; the rest expand, and Dismiss hides one", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let hotspots = [hotspot("docs/agent-map/api.md", 5), hotspot("config/allowlist.txt", 4), hotspot("README.md", 3), hotspot("notes ü [draft].md", 3)];
    const dismissed: unknown[] = [];
    const theme = process.env.ALICE_HOTSPOT_THEME ?? "default";
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
        "/api/boards": [{ id: "board", repo: "/tmp/repo", conflictHotspots: hotspots }],
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
    assert.match(text, /docs\/agent-map\/api\.md conflicted on 5 cards in the last 14 days/);
    assert.match(text, /\/docs\/agent-map\/api\.md merge=union/);
    assert.match(text, /Generate it/);
    assert.match(text, /depend on each other/);
    assert.equal(await page.getByTestId("conflict-hotspot").count(), 3, "three at first");

    // The fourth file is folded away, not dismissed: expanding shows it with its escaped .gitattributes line.
    if (process.env.ALICE_HOTSPOT_SCREENSHOT) await page.screenshot({ path: process.env.ALICE_HOTSPOT_SCREENSHOT.replace(/\.png$/, "-collapsed.png") });
    const fourth = page.getByRole("status", { name: "Conflict hint for notes ü [draft].md" });
    assert.equal(await fourth.count(), 0);
    await page.getByRole("button", { name: "Show 1 more file" }).click();
    await fourth.waitFor();
    assert.match(await fourth.innerText(), /"\/notes ü \\\\\[draft\\\\\]\.md" merge=union/);
    assert.equal(await page.getByTestId("conflict-hotspot").count(), 4);
    assert.deepEqual(dismissed, [], "expanding dismisses nothing");
    if (process.env.ALICE_HOTSPOT_SCREENSHOT) await page.screenshot({ path: process.env.ALICE_HOTSPOT_SCREENSHOT, fullPage: true });

    await page.getByRole("button", { name: "Dismiss conflict hint for docs/agent-map/api.md" }).click();
    await notice.waitFor({ state: "detached" });
    assert.deepEqual(dismissed, ["docs/agent-map/api.md"]);
    await page.getByRole("status", { name: "Conflict hint for config/allowlist.txt" }).waitFor();
    assert.equal(await page.getByTestId("conflict-hotspot").count(), 3);
  } finally {
    await browser.close();
    await server.close();
  }
});
