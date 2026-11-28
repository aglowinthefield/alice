import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("card details split the cost by kind and the tile marks cards where rework is over half the cost", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const card = (id: string, status: string, attempts: number, cost: number, reworkCost: number | null) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts, reviewRounds: 0, runAgent: "", reviewAgent: "", cost, reworkCost });
    const run = (attempt: number, kind: string, cost: number) => ({ id: `run-${attempt}`, attempt, kind, cost, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual", agent: "" });
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card("churned", "review", 2, 2.25, 1.5), card("cheap", "review", 2, 2, 0.5)],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/churned/runs": [run(2, "ci_fix", 1.5), run(1, "first", 0.75)],
      "/api/boards/board/cards/churned/approval": { pending: false },
      "/api/boards/board/cards/churned/push-progress": null,
      "/api/boards/board/cards/churned/history": [],
      "/api/boards/board/cards/churned/comments": [],
      "/api/boards/board/cards/churned/auto-review": [],
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      if (!(path in data)) { await route.fulfill({ status: 404, json: { error: `Unexpected API request: ${path}` } }); return; }
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const churned = page.getByRole("button", { name: /churned card/ });
    await churned.getByTestId("rework-cost").waitFor();
    assert.equal((await churned.getByTestId("rework-cost").textContent())?.trim(), "67% rework");
    assert.equal(await churned.getByTestId("rework-cost").getAttribute("title"), "Rework cost $1.50 of $2.25: runs after the first attempt");
    const cheap = page.getByRole("button", { name: /cheap card/ });
    await cheap.waitFor();
    assert.equal(await cheap.getByTestId("rework-cost").count(), 0, "rework at a quarter of the cost shows no marker");
    if (process.env.ALICE_EVIDENCE_DIR) await page.locator('section[data-status="review"]').screenshot({ path: `${process.env.ALICE_EVIDENCE_DIR}/rework-marker.png` });

    await churned.click();
    await page.getByRole("tab", { name: /^Attempts/ }).click();
    const split = page.getByTestId("cost-split");
    await split.waitFor();
    assert.deepEqual(await split.getByRole("listitem").allTextContents(), ["First attempt: $0.75", "CI or hook fix: $1.50"]);
    assert.match((await page.getByText(/^Card total:/).textContent()) ?? "", /\$2\.25/);
    assert.deepEqual(await page.getByTestId("run-kind").allTextContents(), ["CI or hook fix"], "only runs after the first are labelled");
    if (process.env.ALICE_EVIDENCE_DIR) await page.getByRole("dialog").screenshot({ path: `${process.env.ALICE_EVIDENCE_DIR}/cost-split.png` });
  } finally {
    await browser.close();
    await server.close();
  }
});
