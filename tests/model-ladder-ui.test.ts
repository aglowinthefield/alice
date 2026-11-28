import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { emptyAgentModels } from "../shared/agent-models.js";

test("a repository's Card retries model is saved with its other models and is not in global Settings", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    let board: Record<string, unknown> = { id: "board", repo: "/tmp/example", icon: "sprinkle_donut", color: "violet", remoteUrl: "", agentModels: { ...emptyAgentModels(), work: { model: "anthropic/claude-sonnet-4-5", thinking: "" } } };
    const patches: unknown[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
        const input = route.request().postDataJSON();
        patches.push(input);
        board = { ...board, ...input };
        await route.fulfill({ json: board });
      } else if (path === "/api/boards") await route.fulfill({ json: [board] });
      else if (path === "/api/models") await route.fulfill({ json: { models: ["anthropic/claude-opus-4-1", "anthropic/claude-sonnet-4-5"] } });
      else if (path === "/api/repository-root") await route.fulfill({ json: { root: new URL(route.request().url()).searchParams.get("path") } });
      else if (path === "/api/path-suggestions") await route.fulfill({ json: [] });
      else if (path === "/api/settings") await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default", agentModels: emptyAgentModels() } });
      else if (path.endsWith("/cards") || path.endsWith("/conflicts")) await route.fulfill({ json: [] });
      else if (path.endsWith("/local-merges")) await route.fulfill({ json: { cards: [], main: null } });
      else if (path === "/api/status") await route.fulfill({ json: { draining: false, activeRuns: 0 } });
      else throw new Error(`Unexpected API request: ${path}`);
    });
    await page.goto(new URL("/settings/models", server.resolvedUrls!.local[0]).href);
    await page.getByRole("combobox", { name: "Card runs model" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Card retries model" }).count(), 0, "the ladder is per board, not global");
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.locator("header h1").filter({ hasText: "example" }).waitFor();

    await page.getByRole("button", { name: "Edit /tmp/example" }).click();
    const retry = page.getByRole("combobox", { name: "Card retries model" });
    assert.equal(await retry.inputValue(), "", "off by default");
    assert.equal(await retry.getAttribute("placeholder"), "Off: retries use the Card runs model");
    const save = page.getByRole("button", { name: "Save models" });
    assert.equal(await save.isDisabled(), true);
    await retry.fill(" anthropic/claude-opus-4-1 ");
    await page.getByRole("combobox", { name: "Card retries thinking" }).selectOption("high");
    await retry.scrollIntoViewIfNeeded();
    if (process.env.ALICE_SCREENSHOT) await retry.locator("xpath=ancestor::form").screenshot({ path: process.env.ALICE_SCREENSHOT });
    await save.click();
    await page.waitForFunction(() => (document.querySelector("button[type=submit]:disabled")));
    assert.deepEqual(patches, [{ agentModels: { ...emptyAgentModels(), work: { model: "anthropic/claude-sonnet-4-5", thinking: "" }, retry: { model: "anthropic/claude-opus-4-1", thinking: "high" } } }]);
    // The saved, trimmed value re-renders after the save settles; under load that is after the button disables.
    await page.waitForFunction(input => (input as HTMLInputElement).value === "anthropic/claude-opus-4-1", await retry.elementHandle()).catch(() => undefined);
    assert.equal(await retry.inputValue(), "anthropic/claude-opus-4-1");
  } finally {
    await browser?.close();
    await server.close();
  }
});
