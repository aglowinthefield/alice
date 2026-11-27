import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";

const plain = "Rename `fooBar` to `fooBaz` in `server/board.ts`.\n\n## Acceptance\n- Tests cover the rename.";
const card = (id: string, body: string) => ({ id, title: `${id} card`, body, repo: "/tmp/repo", source: "manual", status: "triage",
  priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 0 });

async function board(page: Page, initial: ReturnType<typeof card>[]) {
  let cards = initial;
  const requests: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() ?? {};
      requests.push(`${path} ${JSON.stringify(body)}`);
      const status = path.match(/\/cards\/(\w+)\/status$/);
      if (status) cards = cards.map(item => item.id === status[1] ? { ...item, status: body.status } : item);
      await route.fulfill({ json: cards.find(item => item.id === status?.[1]) ?? {} }); return;
    }
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": cards,
      "/api/boards/board/conflicts": [],
      "/api/status": { draining: false, activeRuns: 0 },
    };
    if (path in data) { await route.fulfill({ json: data[path] }); return; }
    // What the card details poll for a card that never ran.
    const detail = path.match(/^\/api\/boards\/board\/cards\/\w+\/([\w-]+)$/)?.[1];
    if (detail === "approval") { await route.fulfill({ json: { pending: false } }); return; }
    if (detail === "push-progress") { await route.fulfill({ json: null }); return; }
    if (detail === "dependencies") { await route.fulfill({ json: { dependsOn: [], dependents: [] } }); return; }
    if (detail === "discussion") { await route.fulfill({ json: { messages: [], pending: false } }); return; }
    if (detail) { await route.fulfill({ json: [] }); return; }
    assert.fail(`Unexpected API request: ${path}`);
  });
  return requests;
}

test("Move to Ready in the card's details flags a physical-device ask and moves on Ready anyway", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const requests = await board(page, [
      card("share", "The share sheet crashes on iOS 18.\n\nVerify on a physical iPhone before review.\n\n## Acceptance\n- The sheet opens."),
      card("rename", plain),
    ]);
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const lane = (status: string) => page.locator(`section[data-status="${status}"]`);
    const check = page.getByRole("dialog", { name: "This card may need another pass" });

    // The first render waits on a cold Vite compile, so it gets the page-load timeout.
    await lane("triage").getByRole("button", { name: /rename card/ }).waitFor({ timeout: 30_000 });
    // A plain code task moves straight away.
    await lane("triage").getByRole("button", { name: /rename card/ }).click();
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await page.getByRole("button", { name: "Move to Ready" }).waitFor({ state: "detached" });
    assert.equal(await check.count(), 0);
    await page.keyboard.press("Escape");
    await lane("ready").getByRole("button", { name: /rename card/ }).waitFor();

    await lane("triage").getByRole("button", { name: /share card/ }).click();
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await check.waitFor();
    const flags = check.getByTestId("ready-flags");
    assert.match(await flags.innerText(), /Needs a physical device, which the agent does not have\s+“Verify on a physical iPhone before review\.”/);
    assert.doesNotMatch(await flags.innerText(), /acceptance/i, "the card has acceptance criteria");
    // Evidence for review: ALICE_READY_CHECK_SHOT=path.png saves the dialog.
    if (process.env.ALICE_READY_CHECK_SHOT) await page.screenshot({ path: process.env.ALICE_READY_CHECK_SHOT });
    assert.equal(requests.length, 1, "nothing moves while the check is open");
    await check.getByRole("button", { name: "Ready anyway" }).click();
    await page.getByRole("button", { name: "Move to Ready" }).waitFor({ state: "detached" });
    await check.waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await lane("ready").getByRole("button", { name: /share card/ }).waitFor();
    assert.deepEqual(requests, ['/api/boards/board/cards/rename/status {"status":"ready"}', '/api/boards/board/cards/share/status {"status":"ready"}']);
  } finally { await browser.close(); await server.close(); }
});

test("moving several Triage cards to Ready lists each flagged card once", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const requests = await board(page, [card("vague", "Tidy up the sidebar."), card("staging", `Deploy to staging and confirm the banner.${"\n\n"}## Acceptance${"\n"}- It shows.`), card("rename", plain)]);
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const triage = page.locator('section[data-status="triage"]');
    await triage.getByRole("button", { name: "Select in Triage" }).waitFor({ timeout: 30_000 });
    await triage.getByRole("button", { name: "Select in Triage" }).click();
    await triage.getByRole("checkbox", { name: "Select all" }).check();
    await triage.getByLabel("Move selected cards to").selectOption({ label: "Ready" });
    await triage.getByRole("button", { name: "Move", exact: true }).click();
    const check = page.getByRole("dialog", { name: "2 of 3 cards may need another pass" });
    await check.waitFor();
    const text = await check.getByTestId("ready-flags").innerText();
    assert.match(text, /vague card\s+No acceptance criteria/);
    assert.match(text, /staging card\s+Needs staging or production/);
    assert.doesNotMatch(text, /rename card/);
    await check.getByRole("button", { name: "Ready anyway" }).click();
    await page.locator('section[data-status="ready"]').getByRole("button", { name: /vague card/ }).waitFor();
    assert.equal(requests.length, 3);
  } finally { await browser.close(); await server.close(); }
});
