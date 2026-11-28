import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("a follow-up added from a run report is created with source follow-up, and Details shows a card's source", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Ship the importer", body: "", repo: "/tmp/repo", source: "manual", status: "done", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false, idempotencyKey: "alice-local-1234" };
    const run = { id: "run", cardId: "card", attempt: 1, status: "review", report: "Done.\n\n## Follow-ups\n- Add an index on `cards.repo`", output: "", error: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, startedBy: "manual", agent: "", lastActivityAt: null, ciFix: 0, failureKind: null, recoveryOf: null, retryScheduled: 0, changedFiles: null };
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [run],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/push-progress": null,
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/history": [],
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/status": { draining: false, activeRuns: 0 },
    };
    const posts: unknown[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/boards/board/cards") {
        posts.push(request.postDataJSON());
        await route.fulfill({ status: 201, json: { ...card, id: "made", source: "follow-up" } });
        return;
      }
      // A Done card's details may poll extra read-only endpoints; answer them empty.
      await route.fulfill({ json: path in data ? data[path] : [] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: "Expand Done lane" }).click();
    await page.getByRole("button", { name: /Ship the importer/ }).first().click();
    await page.getByRole("button", { name: "Add to Triage" }).click();
    await page.getByRole("button", { name: "In Triage" }).waitFor();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { title: "Add an index on cards.repo", body: "Add an index on `cards.repo`\n\nFollow-up from card card: Ship the importer", idempotencyKey: "follow-up:run:0", source: "follow-up" });
    await page.getByRole("tab", { name: "Details" }).click();
    const source = page.getByTestId("card-source");
    await source.waitFor();
    assert.equal((await source.textContent())?.trim(), "Sourcemanual(made before Alice recorded sources)");
  } finally { await browser.close(); await server.close(); }
});
