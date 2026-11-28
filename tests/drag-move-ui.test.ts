import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { dropTargets, type Card } from "../src/model.js";

const card = (id: string, status: string, attempts = 0) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
  priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts });

test("drop targets mirror the card's own move buttons", () => {
  const targets = (status: string, attempts = 0) => dropTargets(card("x", status, attempts) as unknown as Card);
  assert.deepEqual(targets("triage"), ["ready", "done"]);
  assert.deepEqual(targets("ready"), ["triage", "running", "done"]);
  assert.deepEqual(targets("ready", 1), ["running"], "a card with runs can't go back to Triage or skip to Done");
  assert.deepEqual(dropTargets({ ...card("x", "ready"), blocked: true } as unknown as Card), ["triage", "done"], "a never-run card waiting on dependencies can't start");
  assert.deepEqual(dropTargets({ ...card("x", "ready", 1), blocked: true } as unknown as Card), ["running"], "a retry isn't gated");
  assert.deepEqual(targets("failed", 1), ["ready", "running"]);
  assert.deepEqual(targets("done", 1), ["archived"]);
  assert.deepEqual(targets("archived", 1), ["done"]);
  for (const status of ["running", "review", "interrupted"]) assert.deepEqual(targets(status, 1), [], `${status} cards don't drag`);
});

test("dragging a card onto a valid lane moves it; other lanes refuse the drop", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let cards = [card("idea", "triage"), card("queued", "ready"), card("shipped", "done", 1), card("busy", "review", 1)];
    const requests: string[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method();
      const move = (id: string, status: string) => { cards = cards.map(item => item.id === id ? { ...item, status } : item); };
      if (method === "POST") {
        const body = route.request().postDataJSON() ?? {};
        requests.push(`${path} ${JSON.stringify(body)}`);
        const status = path.match(/\/cards\/(\w+)\/status$/);
        if (status) move(status[1], body.status);
        const start = path.match(/\/cards\/(\w+)\/start$/);
        if (start) move(start[1], "running");
        if (path.endsWith("/cards/archive")) for (const id of body.cardIds) move(id, "archived");
        await route.fulfill({ json: {} }); return;
      }
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo" }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": cards,
        "/api/boards/board/conflicts": [],
      };
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: "Expand Done lane" }).click();
    const lane = (status: string) => page.locator(`section[data-status="${status}"]`);
    const tile = (name: string) => page.getByRole("button", { name: new RegExp(`${name} card`) });
    await tile("idea").waitFor();
    assert.equal(await tile("busy").getAttribute("draggable"), "false", "Review cards need the review screen");

    // Review isn't a next state for Triage, so dropping there does nothing.
    await tile("idea").dragTo(lane("review"));
    assert.deepEqual(requests, []);

    // "idea" has no description, so the Ready check asks first. Closing the dialog moves nothing.
    const check = page.getByRole("dialog", { name: "This card may need another pass" });
    await tile("idea").dragTo(lane("ready"));
    await check.getByText("The card has no description, so nothing describes the finished result").waitFor();
    await page.keyboard.press("Escape");
    await check.waitFor({ state: "hidden" });
    assert.deepEqual(requests, [], "closing the check leaves the card in Triage");
    // Edit opens the card's edit form instead of moving it.
    await tile("idea").dragTo(lane("ready"));
    await check.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit card" });
    await edit.waitFor();
    assert.equal(await edit.getByRole("textbox").first().inputValue(), "idea card");
    await page.keyboard.press("Escape");
    await edit.waitFor({ state: "hidden" });
    assert.deepEqual(requests, []);
    // Ready anyway is the one extra click.
    await tile("idea").dragTo(lane("ready"));
    await check.getByRole("button", { name: "Ready anyway" }).click();
    await lane("ready").getByRole("button", { name: /idea card/ }).waitFor();
    await tile("queued").dragTo(lane("running"));
    await lane("running").getByRole("button", { name: /queued card/ }).waitFor();
    // The empty Archive lane is folded shut; its narrow column still takes the drop.
    await tile("shipped").dragTo(page.locator('section[data-status="archived"]'));
    await page.waitForFunction(() => !document.querySelector('section[data-status="done"] button[draggable]'));
    assert.deepEqual(requests, [
      '/api/boards/board/cards/idea/status {"status":"ready"}',
      "/api/boards/board/cards/queued/start {}",
      '/api/boards/board/cards/archive {"cardIds":["shipped"]}',
    ]);
  } finally { await browser.close(); await server.close(); }
});
