import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("unattended review is configured per repository, not in global Settings", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const boards = [
      { id: "first", repo: "/tmp/first/app", icon: "sprinkle_donut", color: "violet", autoReviewEnabled: true },
      { id: "second", repo: "/tmp/second/app", icon: "sprinkle_donut", color: "violet", autoReviewEnabled: false },
    ];
    const patches: Record<string, unknown>[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as Record<string, unknown>;
        patches.push(patch);
        Object.assign(boards.find(item => path.includes(`/${item.id}/`))!, patch);
        await route.fulfill({ json: boards.find(item => path.includes(`/${item.id}/`)) });
        return;
      }
      await route.fulfill({ json: path === "/api/boards" ? boards
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : path === "/api/repository-root" ? { root: "/tmp" }
        : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/board/first`);
    await page.getByRole("link", { name: "Settings" }).click();
    const settingsPage = page.locator("main:visible");
    await settingsPage.getByText("Confirm before starting a run").waitFor();
    assert.equal(await settingsPage.getByText("Unattended review", { exact: true }).count(), 0);
    await page.goBack();

    // The edit pencil lives on the open board's heading.
    await page.getByRole("link", { name: "Kanban" }).click();
    await page.getByRole("button", { name: "Edit /tmp/first/app" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Unattended review", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: /verification command/i }).count(), 0, "no verification command to set");
    assert.equal(await dialog.getByRole("spinbutton", { name: /merge limit/i }).count(), 0, "nothing merges unattended, so there is no merge limit");
    await dialog.getByText("Nothing merges into main without you.").waitFor();
    await dialog.getByRole("button", { name: "Turn off unattended review" }).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Repository root" }).evaluate(input => input === document.activeElement), false,
      "the repository path picker is not focused when editing a repository");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "app", exact: true }).nth(1).click();
    await page.getByRole("link", { name: "Kanban" }).last().click();
    await page.getByRole("button", { name: "Edit /tmp/second/app" }).click();
    const confirms: string[] = [];
    page.on("dialog", async confirm => { confirms.push(confirm.message()); await confirm.accept(); });
    await dialog.getByRole("button", { name: "Turn on unattended review" }).click();
    await dialog.getByRole("button", { name: "Turn off unattended review" }).waitFor();
    assert.match(confirms[0] ?? "", /Turn on unattended review for \/tmp\/second\/app\?/);
    assert.deepEqual(patches, [{ autoReviewEnabled: true }]);
  } finally { await browser.close(); await server.close(); }
});
