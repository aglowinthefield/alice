import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";

const card = (id: string, status: string, title: string) => ({
  id,
  title,
  body: "",
  repo: "/tmp/repo",
  source: "ui",
  status,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  turns: 0,
  turnsIncomplete: 0,
});

test("the new-card dialog starts cards in Ready, offers Triage, and holds a card with files in Triage until they are up", async () => {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("alice-view", "board"));
    let autoPickup = false;
    const posts: [string, unknown][] = [];
    // While set, a card-create request calls `hold.arrived` and waits for `hold.gate` before it is answered.
    let hold: { gate: Promise<void>; arrived: () => void } | null = null;
    await page.route("**/api/**", async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        posts.push([path, path.endsWith("/attachments") ? "file" : request.postDataJSON()]);
        if (path === "/api/boards/board/cards") {
          if (hold) { hold.arrived(); await hold.gate; }
          return route.fulfill({ json: card("new", request.postDataJSON().triage ? "triage" : "ready", request.postDataJSON().title) });
        }
        if (path.endsWith("/attachments"))
          return route.fulfill({ json: { id: "a1", cardId: "new", messageId: null, name: "notes.txt", type: "text/plain", size: 5, createdAt: "2026-01-01" } });
        return route.fulfill({ json: card("new", "ready", "With files") });
      }
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false, autoPickupEnabled: autoPickup, pickupConcurrency: 1 }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/status": { draining: false, activeRuns: 0 },
        "/api/boards/board/cards/new/approval": { pending: false },
        "/api/boards/board/cards/new/push-progress": null,
      };
      // Everything else (the board's cards, the opened card's runs, history and so on) is empty.
      await route.fulfill({ json: path in data ? data[path] : [] });
    });

    const create = async (title: string, options: { triage?: boolean; file?: boolean; hint: RegExp }) => {
      await page.goto(server.resolvedUrls!.local[0]);
      await page.getByRole("button", { name: "repo", exact: true }).click();
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("n");
      const dialog = page.getByRole("dialog");
      await dialog.getByPlaceholder("What needs doing?").fill(title);
      if (options.triage) await dialog.getByRole("checkbox", { name: "Start in Triage" }).check();
      if (options.file) await dialog.getByLabel("Attach files").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
      assert.match(await hintText(page), options.hint);
      await dialog.getByRole("button", { name: "Create card" }).click();
      await page.getByRole("heading", { name: "New card" }).waitFor({ state: "detached" });
    };

    await create("Decided", { hint: /starts in Ready\. Creating a card does not start an agent/ });
    await create("Unsure", { triage: true, hint: /waits in Triage until you move it to Ready/ });
    autoPickup = true;
    await create("With files", { file: true, hint: /auto pickup may start a run on it soon/ });

    const card_ = (title: string, triage: boolean) => ["/api/boards/board/cards", { title, body: "", priority: 0, origin: "ui", triage }];
    assert.deepEqual(posts, [
      card_("Decided", false),
      card_("Unsure", true),
      // Pickup must not start it before its files are attached, so it moves to Ready only after the upload.
      card_("With files", true),
      ["/api/boards/board/cards/new/attachments", "file"],
      ["/api/boards/board/cards/new/status", { status: "ready" }],
    ]);

    // Submitting again while the create is pending, by a second submit in the same task or by Cmd/Ctrl+Enter, sends nothing.
    posts.length = 0;
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { arrived = resolve; });
    hold = { gate, arrived };
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "repo", exact: true }).click();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("n");
    const dialog = page.getByRole("dialog"), title = dialog.getByPlaceholder("What needs doing?");
    await title.fill("Only once");
    await title.evaluate(element => { const form = element.closest("form")!; form.requestSubmit(); form.requestSubmit(); });
    await reached;
    assert.equal(await dialog.getByRole("button", { name: "Create card" }).isDisabled(), true, "Create card is disabled while pending");
    await title.press("Meta+Enter");
    await title.press("Control+Enter");
    release();
    await page.getByRole("heading", { name: "New card" }).waitFor({ state: "detached" });
    assert.deepEqual(posts, [card_("Only once", false)]);
  } finally {
    await browser.close();
    await server.close();
  }
});

/** The sentence under the Triage checkbox that says where the card will start. */
async function hintText(page: Page): Promise<string> {
  return page.getByRole("dialog").locator("label:has-text('Start in Triage') + p").innerText();
}
