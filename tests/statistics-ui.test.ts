import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { buildStats } from "../server/stats.js";

let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

const board = { autoCollapseEmptySwimlanes: false, autoPickupEnabled: false, autoReviewEnabled: false, icon: "rocket", color: "violet", cardCounts: {} };
const boards = [{ ...board, id: "board-a", repo: "/code/alpha" }, { ...board, id: "board-b", repo: "/code/beta" }];
const now = Date.now();
const run = (over: object) => ({ repo: "/code/alpha", id: "r", cardId: "c", attempt: 1, kind: "first" as const, timedOut: 0, status: "review", startedBy: "manual", agent: "pi · sonnet", ciFix: 0, startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: new Date(now - 3_000_000).toISOString(), cost: 1.5, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, cacheTasks: 0, cacheHits: 0, cacheSavedMs: 0, ...over });
const data = {
  runs: [run({}), run({ id: "r2", attempt: 2, kind: "send_back" as const, status: "failed", cost: 0.5, timedOut: 1 }), run({ repo: "/code/beta", id: "r3", cardId: "d", agent: "pi · opus", startedBy: "auto" })],
  reviews: [{ repo: "/code/alpha", cardId: "c", sendBack: "Attach a screenshot of the layout", state: "needs_human", agent: "pi", startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: null, cost: 0 }],
  cards: [
    { repo: "/code/alpha", id: "c", title: "Fix flaky login", status: "review", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), attempts: 2, reviewRounds: 0, ciReworks: 0 },
    { repo: "/code/beta", id: "d", title: "Docs pass", status: "review", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), attempts: 1, reviewRounds: 0, ciReworks: 0 },
  ],
};

test("Statistics charts the aggregated stats and refetches when the range or repository changes", async () => {
  const page = await browser.newPage();
  const queries: string[] = [];
  await page.route("**/api/**", async route => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/boards") return route.fulfill({ json: boards });
    if (request.pathname === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" } });
    if (request.pathname === "/api/stats") {
      queries.push(request.search);
      const repo = request.searchParams.get("repo"), days = request.searchParams.get("days");
      return route.fulfill({ json: buildStats(data, { days: days === "all" ? null : Number(days), repo }) });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Statistics" }).click();
    await page.getByRole("heading", { name: "Statistics" }).waitFor();
    await page.getByText("$3.50").first().waitFor();
    assert.equal(await page.locator(".recharts-wrapper").count(), 6);
    assert.deepEqual(queries, ["?days=30"]);
    await page.getByRole("combobox", { name: "Time range" }).selectOption("7");
    await page.getByRole("combobox", { name: "Repository" }).selectOption({ label: "beta" });
    await page.getByText("$1.50").first().waitFor();
    assert.equal(queries.at(-1), `?days=7&repo=${encodeURIComponent("/code/beta")}`);
    await page.reload();
    await page.getByRole("heading", { name: "Statistics" }).waitFor();
  } finally { await page.close(); }
});

test("the churn panel shows each board's week and links the cards with the most attempts", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/**", async route => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/boards") return route.fulfill({ json: boards });
    if (request.pathname === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default-system" } });
    if (request.pathname === "/api/stats") return route.fulfill({ json: buildStats(data, { days: 30, repo: null }) });
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(new URL("/stats", url).href);
    const churn = page.getByTestId("churn");
    await churn.waitFor();
    const rows = await churn.locator("tbody tr").evaluateAll(items => items.map(item => [...item.querySelectorAll("td")].map(cell => cell.textContent?.trim())));
    // Columns: week, board, runs, runs per card, rework, send-backs, verification, visual or device, PR write-up, code, timeouts, most attempts.
    assert.deepEqual(rows.map(cells => cells.slice(1, 11)), [
      ["alpha", "2", "2.0", "25%", "1", "0", "1", "0", "0", "1"],
      ["beta", "1", "1.0", "0%", "0", "0", "0", "0", "0", "0"],
    ]);
    assert.equal(rows[0][11], "Fix flaky login2/2");
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, scheme === "light" ? "light" : "default");
      if (process.env.BAKERY_EVIDENCE_DIR) await churn.locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]").screenshot({ path: `${process.env.BAKERY_EVIDENCE_DIR}/churn-panel-${scheme}.png` });
    }
    await page.getByRole("link", { name: "Fix flaky login" }).click();
    await page.waitForURL(/\/board\/board-a\/card\/c$/);
  } finally { await page.close(); }
});
