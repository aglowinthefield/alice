import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Close without merging offers one-click reasons, a note for Other, and closing without a reason", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Backfill", body: "", repo: "/tmp/repo", source: "manual", status: "review", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 2, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false };
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/push-progress": null,
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/history": [],
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/status": { draining: false, activeRuns: 0 },
    };
    let closes = 0;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      // The card stays in Review in this mock, so each pass can open the dialog again.
      if (path === "/api/boards/board/cards/card/close") { closes++; return route.fulfill({ json: card }); }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: /Backfill/ }).click();
    const dialog = page.getByTestId("close-card-dialog");
    const open = async () => {
      await page.getByRole("button", { name: "Close without merging" }).click();
      await dialog.waitFor();
    };
    // Waits on the close request itself and returns the body it sent.
    const close = async (click: () => Promise<void>) => {
      const [request] = await Promise.all([page.waitForRequest(request => request.url().endsWith("/cards/card/close")), click()]);
      await dialog.waitFor({ state: "detached" });
      return request.postDataJSON();
    };

    await open();
    assert.deepEqual(await close(() => dialog.getByRole("button", { name: "Duplicate" }).click()), { reason: "duplicate" });

    await open();
    await dialog.getByRole("button", { name: "Other" }).click();
    await dialog.getByRole("textbox", { name: "Other reason" }).fill("  Upstream fixed it  ");
    assert.deepEqual(await close(() => dialog.getByRole("button", { name: "Close card" }).click()), { reason: "other", note: "Upstream fixed it" });

    await open();
    assert.deepEqual(await close(() => dialog.getByRole("button", { name: "Close without a reason" }).click()), {});

    await open();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });

    assert.equal(closes, 3, "Cancel sends nothing");
  } finally { await browser.close(); await server.close(); }
});
