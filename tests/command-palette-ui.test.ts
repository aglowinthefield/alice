import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const card = (id: string, status: string, title: string) => ({
  id,
  title,
  body: "",
  repo: "/tmp/repo",
  source: "manual",
  status,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  turns: 0,
  turnsIncomplete: 0,
  attempts: 0,
});

const boardCards = [
  card("a1b2c3d4-0000", "triage", "Fix login redirect"),
  card("e5f6a7b8-0000", "ready", "Polish sidebar"),
  card("c9d0e1f2-0000", "done", "Add export button"),
];
const otherCards = [card("9999aaaa-0000", "ready", "Other board card")];

test("command palette: open anywhere, search cards, run board actions", async () => {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("alice-view", "board"),
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") {
        return route.fulfill({
          json:
            path === "/api/settings"
              ? { confirmRunStart: false, theme: request.postDataJSON().theme }
              : {},
        });
      }
      const data: Record<string, unknown> = {
        "/api/boards": [
          { id: "board", repo: "/tmp/repo" },
          {
            id: "other",
            repo: "/tmp/other",
          },
        ],
        "/api/cards": [...boardCards, ...otherCards],
        "/api/settings": {
          confirmRunStart: false,
          cardDetailsLayout: "dialog",
          theme: "default",
        },
        "/api/boards/board/cards": boardCards,
        "/api/boards/board/conflicts": [],
        "/api/boards/other/cards": otherCards,
        "/api/boards/other/conflicts": [],
      };
      if (/\/(runs|comments|auto-review|history)$/.test(path))
        return route.fulfill({ json: [] });
      if (path.endsWith("/approval"))
        return route.fulfill({ json: { pending: false } });
      if (path.endsWith("/push-progress")) return route.fulfill({ json: null });
      if (path === "/api/status")
        return route.fulfill({ json: { draining: false, activeRuns: 0 } });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "repo", exact: true }).click();
    await page
      .locator("section[data-status]")
      .getByText("Fix login redirect", { exact: true })
      .waitFor();

    const palette = page.getByRole("dialog", { name: "Command palette" });
    const field = palette.getByRole("combobox");
    const option = (name: string | RegExp) =>
      palette.getByRole("option", { name });
    const open = async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await field.waitFor();
    };

    // Opens from inside a text field, and uses the shared dialog motion.
    await page
      .getByPlaceholder(/Search/)
      .first()
      .focus();
    await open();
    assert.equal(
      await palette.evaluate((node) => getComputedStyle(node).animationName),
      "dialog-pop-in",
    );
    // Each command shows its shortcut; cards appear only once you type.
    assert.match(await option(/^New card/).innerText(), /n$/);
    assert.match(await option(/^Go to Today/).innerText(), /g\s*t$/);
    assert.equal(await option("Fix login redirect").count(), 0);
    await page.keyboard.press("ControlOrMeta+k");
    await palette.waitFor({ state: "detached" });

    // Searching by title opens the card.
    await open();
    await field.fill("export");
    await option(/^Add export button/).waitFor();
    await page.keyboard.press("Enter");
    await palette.waitFor({ state: "detached" });
    await page.getByRole("dialog", { name: /Add export button/ }).waitFor();
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: /Add export button/ })
      .waitFor({ state: "detached" });

    // Move to Ready with no card focused asks which card, listing only cards that can move there.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await open();
    await field.fill("ready");
    await option(/^Move to Ready/).click();
    await option(/^Fix login redirect/).waitFor();
    assert.equal(await option(/^Polish sidebar/).count(), 0);
    // Escape steps back to the first page before it closes the palette.
    await page.keyboard.press("Escape");
    await option(/^New card/).waitFor();
    await field.fill("ready");
    await page.keyboard.press("Enter");
    await field.fill("login");
    const moved = page.waitForRequest((request) =>
      request.url().endsWith("/api/boards/board/cards/a1b2c3d4-0000/status"),
    );
    await page.keyboard.press("Enter");
    // The card has no description, so the same check as dragging to Ready asks first.
    await page.getByRole("button", { name: "Ready anyway" }).click();
    assert.deepEqual((await moved).postDataJSON(), { status: "ready" });
    await palette.waitFor({ state: "detached" });

    // With a card focused, Start acts on it directly.
    await page.locator("[data-card-id='e5f6a7b8-0000']").focus();
    await open();
    await field.fill("start");
    assert.match(await option(/^Start/).innerText(), /Polish sidebar/);
    const started = page.waitForRequest((request) =>
      request.url().endsWith("/api/boards/board/cards/e5f6a7b8-0000/start"),
    );
    await page.keyboard.press("Enter");
    await started;
    await palette.waitFor({ state: "detached" });

    // Switch theme marks the current one and saves the choice.
    await open();
    await field.fill("theme");
    await page.keyboard.press("Enter");
    assert.match(
      await option(/^Default/)
        .first()
        .innerText(),
      /Current/,
    );
    await field.fill("nord");
    const saved = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/settings") && request.method() === "PATCH",
    );
    await page.keyboard.press("Enter");
    assert.deepEqual((await saved).postDataJSON(), { theme: "nord" });
    await palette.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      "nord",
    );

    // New card opens the form with the cursor in it.
    await open();
    await field.fill("new");
    await page.keyboard.press("Enter");
    const form = page.getByRole("dialog", { name: "New card" });
    await form.waitFor();
    await page.waitForFunction(() =>
      document.activeElement
        ?.closest("[role='dialog']")
        ?.textContent?.includes("New card"),
    );
    await page.keyboard.press("Escape");
    await form.waitFor({ state: "detached" });

    // Switch board.
    await open();
    await field.fill("board");
    await option(/^Switch board/).click();
    await option(/^other/).click();
    await page
      .locator("section[data-status]")
      .getByText("Other board card", { exact: true })
      .waitFor();

    // Settings, from a page other than the board.
    await open();
    await field.fill("settings");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/settings/);

    // Reduced motion shortens the dialog animation to nothing.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open();
    assert.equal(
      await palette.evaluate(
        (node) => getComputedStyle(node).animationDuration,
      ),
      "0.001s",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
