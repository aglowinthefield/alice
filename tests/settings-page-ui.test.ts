import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

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

const settings = { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" };

test("Settings is a page with category sidebar; Updates shows the version and pending commits and installs them", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let installs = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: { draining: false, activeRuns: 0, version: "0.1.0", commit: "e3c5357", date: "2026-10-28T12:00:00Z", updates: { commits: [{ sha: "abc1234", subject: "Add the settings page" }], installing: false, error: null } } });
    if (path === "/api/update") { installs++; return route.fulfill({ status: 202, json: { commits: [], installing: true, error: null } }); }
    if (path === "/api/settings") return route.fulfill({ json: settings });
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(new URL("/today", url).href);
    await page.getByRole("link", { name: "Settings" }).click();
    assert.equal(new URL(page.url()).pathname, "/settings/general");
    assert.equal(await page.getByRole("dialog").count(), 0, "a page, not a popup");
    await page.getByRole("checkbox", { name: /Confirm before starting a run/ }).waitFor();

    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Updates" }).click();
    assert.equal(new URL(page.url()).pathname, "/settings/updates");
    assert.equal(await page.getByTestId("settings-version").textContent(), "0.1.0");
    await page.getByText("e3c5357", { exact: true }).first().waitFor();
    assert.match(await page.getByTestId("settings-footer-version").textContent() ?? "", /Alice 0\.1\.0\s*e3c5357/);
    await page.getByText("Add the settings page").waitFor();
    await page.getByRole("button", { name: "Update and restart" }).click();
    await page.waitForFunction(() => true);
    assert.equal(installs, 1);

    await page.goBack();
    assert.equal(new URL(page.url()).pathname, "/today", "switching categories does not stack history entries");
    await page.goto(new URL("/settings/appearance", url).href);
    await page.getByRole("group", { name: "Theme" }).waitFor();
  } finally { await page.close(); }
});

test("the telemetry toggle is hidden without an endpoint, and saves when shown", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let current: Record<string, unknown> = { ...settings, telemetryAvailable: false, telemetryEnabled: false };
  const patches: unknown[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: { draining: false, activeRuns: 0, version: "0.1.0", commit: null, date: null, updates: null } });
    if (path === "/api/settings") {
      if (route.request().method() === "PATCH") { const patch = route.request().postDataJSON(); patches.push(patch); current = { ...current, ...patch }; }
      return route.fulfill({ json: current });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(new URL("/settings/general", url).href);
    await page.getByRole("checkbox", { name: /Confirm before starting a run/ }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: /anonymous usage counts/ }).count(), 0);
    current = { ...current, telemetryAvailable: true };
    await page.reload();
    const toggle = page.getByRole("checkbox", { name: /anonymous usage counts/ });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.waitForFunction(() => true);
    assert.deepEqual(patches, [{ telemetryEnabled: true }]);
  } finally { await page.close(); }
});
