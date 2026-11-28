import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Review cards marked as your turn come first, cards an agent or GitHub still has sit apart and show who has them", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const recent = new Date().toISOString(), stale = new Date(Date.now() - 12 * 60_000).toISOString();
  const cards: Record<string, Record<string, unknown>> = {
    mine: { status: "review", reviewWait: null },
    agent: { status: "running", reviewWait: null, lastActivityAt: recent },
    github: { status: "review", reviewWait: "github" },
    code: { status: "review", reviewWait: null, reviewAction: "pr_ready" },
    findings: { status: "review", reviewWait: null, reviewAction: "accept_findings" },
    checking: { status: "review", reviewWait: "agent_review", reviewAction: null },
    busy: { status: "running", lastActivityAt: recent },
    quiet: { status: "running", lastActivityAt: stale },
    looping: { status: "running", lastActivityAt: recent, stuck: "repeated the same bash call 5 times in its last 20 tool calls" },
  };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, notifyOnReview: true, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": Object.entries(cards).map(([id, fields]) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual",
        createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 1, ...fields })),
      "/api/boards/board/conflicts": [],
    };
    if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  const tile = (id: string) => page.getByRole("button", { name: new RegExp(`${id} card`) });
  try {
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await tile("mine").waitFor();
    assert.equal(await tile("busy").getAttribute("data-activity"), "working");
    assert.equal(await tile("quiet").getAttribute("data-activity"), "quiet");
    assert.match(await tile("quiet").innerText(), /Quiet 12m/);
    assert.doesNotMatch(await tile("busy").innerText(), /May be stuck/);
    const stuck = tile("looping").getByTestId("activity-badge");
    assert.equal(await stuck.innerText(), "May be stuck");
    assert.match(await stuck.getAttribute("title") ?? "", /^The run repeated the same bash call 5 times in its last 20 tool calls\. Alice told the agent to try a different approach/);
    assert.equal(await tile("github").getAttribute("data-activity"), "waiting");
    assert.match(await tile("github").innerText(), /Waiting on GitHub/);
    assert.equal(await tile("mine").getAttribute("data-activity"), null);
    assert.equal(await tile("mine").getAttribute("data-turn"), "yours");
    assert.match(await tile("mine").innerText(), /Your turn/i);
    assert.doesNotMatch(await tile("mine").innerText(), /PR ready|Accept findings/i, "an unknown next step keeps the generic label");
    assert.match(await tile("code").innerText(), /PR ready/i);
    assert.equal(await tile("code").getAttribute("data-turn"), "yours");
    assert.match(await tile("findings").innerText(), /Accept findings/i);
    assert.equal(await tile("findings").getAttribute("data-turn"), "yours");
    assert.doesNotMatch(await tile("checking").innerText(), /PR ready|Accept findings/i, "a card an agent still has is not labeled");
    assert.doesNotMatch(await tile("github").innerText(), /PR ready|Accept findings/i);
    assert.equal(await tile("github").getAttribute("data-turn"), null);
    assert.doesNotMatch(await tile("github").innerText(), /Your turn/i);
    const nav = page.getByRole("list", { name: "Card counts" });
    assert.equal(await nav.locator('[data-group="review"]').getAttribute("aria-label"), "Review: 3", "only the cards you can act on count as Review");
    assert.equal(await nav.locator('[data-group="in-progress"]').getAttribute("aria-label"), "In progress: 6");

    // The run finishes and an agent reviews it: it sits below the cards that need you. (tests/push.test.ts covers
    // that its notification waits until the agent hands it over.)
    cards.agent = { status: "review", reviewWait: "agent_review" };
    await tile("agent").getByText("Agent reviewing").waitFor();
    assert.equal(await tile("agent").getAttribute("data-activity"), "working");
    const lane = page.getByRole("region", { name: "Review lane" });
    const order = await lane.locator('button[data-activity], button:not([data-activity]), [role="separator"]').evaluateAll(els =>
      els.map(el => el.getAttribute("role") === "separator" ? el.getAttribute("aria-label") : el.textContent?.match(/(mine|agent|github) card/)?.[1]).filter(Boolean));
    assert.deepEqual(order, ["Your turn", "mine", "Not your turn yet", "agent", "github"]);
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
});
