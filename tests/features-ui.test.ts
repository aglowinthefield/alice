import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { featureSwitches } from "../src/features.js";

const card = {
  id: "k1",
  title: "Plain kanban card",
  body: "",
  repo: "/tmp/gh",
  source: "manual",
  status: "ready",
  priority: 0,
  idempotencyKey: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  dependsOn: [],
  attempts: 0,
  // Stored pull request metadata, kept while the feature is off.
  prNumber: 4242,
  prState: "OPEN",
};
// Stored as GitHub pull requests; with that feature off the server reports the effective mode "local".
const board = (pullRequests: boolean) => ({
  id: "gh",
  repo: "/tmp/gh",
  remoteUrl: "https://github.com/acme/gh",
  integration: pullRequests ? "github-pr" : "local",
  integrationConfigured: "github-pr",
  integrationChosen: true,
  autoCollapseEmptySwimlanes: false,
});

for (const [sentinels, pullRequests] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  test(`UI with sentinels=${sentinels} pullRequests=${pullRequests} shows only the enabled features`, async () => {
    const previous = { ...process.env };
    process.env[featureSwitches.sentinels] = sentinels ? "1" : "0";
    process.env[featureSwitches.pullRequests] = pullRequests ? "1" : "0";
    const server = await createServer({
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    Object.assign(process.env, previous);
    await server.listen();
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/boards")
          return route.fulfill({ json: [board(pullRequests)] });
        if (path === "/api/settings")
          return route.fulfill({
            json: {
              confirmRunStart: false,
              cardDetailsLayout: "dialog",
              theme: "default",
            },
          });
        if (path === "/api/boards/gh/cards")
          return route.fulfill({ json: [card] });
        await route.fulfill({ json: [] });
      });
      await page.goto(server.resolvedUrls!.local[0]);
      const repo = page.getByRole("button", { name: "gh", exact: true });
      await repo.waitFor();
      if ((await repo.getAttribute("aria-expanded")) !== "true")
        await repo.click();
      await page.getByRole("button", { name: "Kanban", exact: true }).click();
      await page.getByText("Plain kanban card").waitFor();
      assert.equal(
        await page.getByRole("button", { name: /^Sentinels/ }).count(),
        sentinels ? 1 : 0,
        "Sentinels navigation",
      );
      assert.equal(
        await page.getByText("PR #4242").count(),
        pullRequests ? 1 : 0,
        "stored PR badge on the card",
      );
      assert.equal(
        await page.getByRole("button", { name: /^Pull requests/ }).count(),
        pullRequests ? 1 : 0,
        "Pull requests navigation",
      );
      // A board stored as pull requests explains why Approve is unavailable while the feature is off.
      assert.equal(
        await page.getByTestId("pull-requests-off-notice").count(),
        pullRequests ? 0 : 1,
        "off-notice",
      );
      if (!pullRequests)
        assert.match(
          await page.getByTestId("pull-requests-off-notice").innerText(),
          /BAKERY_FEATURE_PULL_REQUESTS=1/,
        );
    } finally {
      await browser.close();
      await server.close();
    }
  });
}
