import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// Bakery became Alice: settings a browser saved under bakery-* keys still apply, under their alice-* names.
test("settings saved under Bakery's storage keys carry over to Alice's", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("bakery-view", "board");
      localStorage.setItem("bakery-diff-theme", "one");
      localStorage.setItem("alice-diff-theme", "github");
    });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ json: url.pathname === "/api/settings"
        ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    // The app opens the view it read and records it for this tab; without the old key it would open Today.
    await page.waitForFunction(() => sessionStorage.getItem("alice-view") === "board");
    const stored = await page.evaluate(() => ({
      view: localStorage.getItem("alice-view"),
      oldView: localStorage.getItem("bakery-view"),
      diffTheme: localStorage.getItem("alice-diff-theme"),
    }));
    assert.deepEqual(stored, { view: "board", oldView: "board", diffTheme: "github" }, "copies old keys, keeps them, and never overwrites a new one");
  } finally {
    await browser.close();
    await server.close();
  }
});
