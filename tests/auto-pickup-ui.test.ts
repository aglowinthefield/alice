import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("a capped board shows the reason, next slot, and a confirmed reset in the repository settings", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let board = { id: "board", repo: "/tmp/alice", autoPickupEnabled: true, pickupConcurrency: 2,
      limitsEnabled: true, pickupDailyLimit: 6, autoPickupStarts: 6, autoPickupNextAt: "2026-10-26T07:04:01.000Z" as string | null,
      autoPickupError: "", autoCollapseEmptySwimlanes: false, autoReviewEnabled: false };
    let resets = 0, dialogs = 0;
    page.on("dialog", dialog => { dialogs++; void (dialogs === 1 ? dialog.dismiss() : dialog.accept()); });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/auto-pickup/reset-limit" && route.request().method() === "POST") {
        resets++; board = { ...board, autoPickupStarts: 0, autoPickupNextAt: null };
        await route.fulfill({ json: board }); return;
      }
      if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
        board = { ...board, ...route.request().postDataJSON() }; await route.fulfill({ json: board }); return;
      }
      const data = path === "/api/boards" ? [board]
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : [];
      await route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${address.port}/board/board`);
    await page.getByText(/Auto pickup waiting: 6 \/ 6/).waitFor();
    await page.getByText(/Next slot around/).first().waitFor();
    await page.getByRole("button", { name: "Reset start limit" }).first().click();
    assert.equal(resets, 0, "cancelling does not restart paid pickup");
    await page.getByRole("button", { name: "Reset start limit" }).first().click();
    await page.getByText(/Auto pickup waiting/).waitFor({ state: "hidden" });
    assert.equal(resets, 1);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByText("Auto pickup is set per repository.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Auto pickup daily start limit" }).count(), 0, "global Settings has no pickup controls");
    await page.goBack();
    await page.getByRole("button", { name: "Edit /tmp/alice" }).click();
    await page.getByRole("combobox", { name: "Auto pickup daily start limit" }).selectOption("99");
    await page.getByText(/0 \/ 99 starts/).waitFor();
    assert.equal(board.pickupDailyLimit, 99);
    assert.equal(dialogs, 3, "raising the limit confirms even before a Ready card is polled");
  } finally { await browser.close(); await server.close(); }
});

test("with limits off the start limit, budget and diff caps are hidden and never block; one button turns them on", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Stored limits that would block if they applied: 6 of 6 starts used and a budget below the spend.
    let board = { id: "board", repo: "/tmp/alice", autoPickupEnabled: true, pickupConcurrency: 2,
      limitsEnabled: false, pickupDailyLimit: 6, autoPickupStarts: 6, autoPickupNextAt: null as string | null, pickupCostBudget: 1, cost24h: 3,
      autoPickupBudgetReached: false, autoReviewMaxFiles: 40, autoReviewMaxPatchChars: 100000,
      autoPickupError: "", autoCollapseEmptySwimlanes: false, autoReviewEnabled: false };
    const patches: unknown[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON(); patches.push(patch);
        board = { ...board, ...patch }; await route.fulfill({ json: board }); return;
      }
      const data = path === "/api/boards" ? [board]
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : [];
      await route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${address.port}/board/board`);
    await page.getByText(/Last 24h:/).waitFor();
    assert.equal(await page.getByText(/Auto pickup waiting/).count(), 0, "no start-limit banner while limits are off");
    assert.equal(await page.getByText(/budget/).count(), 0, "the header shows spend without a budget");
    await page.getByRole("button", { name: "Edit /tmp/alice" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/Off: no daily start limit, cost budget or review diff caps/).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Auto pickup daily start limit" }).count(), 0);
    assert.equal(await dialog.getByRole("textbox", { name: "Auto pickup daily cost budget" }).count(), 0);
    assert.equal(await dialog.getByRole("spinbutton", { name: "Largest diff the agent reviewer takes (files)" }).count(), 0);
    await dialog.getByRole("button", { name: "Turn limits on" }).click();
    await dialog.getByRole("combobox", { name: "Auto pickup daily start limit" }).waitFor();
    await dialog.getByRole("spinbutton", { name: "Largest diff the agent reviewer takes (files)" }).waitFor();
    assert.deepEqual(patches, [{ limitsEnabled: true }]);
  } finally { await browser.close(); await server.close(); }
});

test("Settings sets the agents-at-once limit for all boards and shows the automatic value and how many run", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let settings = { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default", maxActiveAgents: 0, activeAgentsLimit: 4, activeAgents: 3 };
    const patches: unknown[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/settings" && route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as { maxActiveAgents: number }; patches.push(patch);
        settings = { ...settings, ...patch, activeAgentsLimit: patch.maxActiveAgents || 4 };
        await route.fulfill({ json: settings }); return;
      }
      await route.fulfill({ json: path === "/api/settings" ? settings : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/settings/general`);
    const select = page.getByRole("combobox", { name: "Agents at once, all boards" });
    await select.waitFor();
    assert.equal(await select.locator("option:checked").textContent(), "Automatic (4)");
    await page.getByText("3 running now.", { exact: false }).waitFor();
    await select.selectOption("2");
    await page.waitForFunction(() => (document.querySelector('select[aria-label="Agents at once, all boards"]') as HTMLSelectElement | null)?.value === "2");
    assert.deepEqual(patches, [{ maxActiveAgents: 2 }]);
  } finally { await browser.close(); await server.close(); }
});
