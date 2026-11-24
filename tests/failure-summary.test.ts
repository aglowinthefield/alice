import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Board } from "../server/board.js";
import { describeToolCall, summarizeFailure } from "../server/failure-summary.js";

test("a failed run's error reads as a few words on why it failed", () => {
  const cases: [string | null, string | null, string | null][] = [
    ["Pi exited (143); Bakery sent SIGTERM: 60-minute run timeout; no settlement event; stderr: Warning: No project session found", null, "Timed out after 60 min"],
    ["Pi exited (143); Bakery sent SIGTERM: 60-minute run timeout; stuck in bash for 31 min: timeout 1800 sh -c 'x'; no settlement event", null, "Timed out: bash ran 31 min"],
    ["Pi exited (143); Bakery sent SIGTERM: 60-minute run timeout; stuck in bash for 0 min: ls; no settlement event", null, "Timed out after 60 min"],
    ["Pi exited (143); Bakery sent SIGTERM: manual stop; no settlement event", null, "Stopped by hand"],
    ["Pi exited (143); Bakery sent SIGTERM: server received SIGTERM; no settlement event", null, "Server restarted mid-run"],
    ["Server restarted while this run was active", null, "Server restarted mid-run"],
    ["Pi exited (SIGKILL); termination source unknown (Bakery did not send SIGTERM); no settlement event", null, "Killed by unknown signal"],
    ["Provider request failed (HTTP 400): 400 {\"type\":\"error\"} [invalid-history: ...]; Pi exited (0); settled", "invalid-history", "Session history rejected"],
    ["Provider request failed (HTTP 502): 502 {\"error\":\"acp-proxy failure\"}", "transient", "Provider or network error"],
    ["Pi exited (0); settled; Provider request failed; stderr logged on server", "unknown", "Provider request failed"],
    ["Pi exited (0); settled; Provider request failed; stderr logged on server", null, "Provider request failed"],
    ["Pi could not start: spawn pi ENOENT", null, "Pi could not start"],
    ["Worktrunk pre-start hooks failed: npm ci exited 1", null, "Worktree setup failed"],
    ["Pi exited (1); no settlement event", null, "Pi crashed (exit 1)"],
    ["Pi exited (0); no settlement event", null, "Pi ended without finishing"],
    ["Pi exited (0); settled; Invalid Pi event stream", null, "Garbled Pi output"],
    ["Error: fatal: 'bakery/x' is already checked out at '/somewhere/very/long'", null, "Error: fatal: 'bakery/x' is already che…"],
  ];
  for (const [error, failureKind, expected] of cases)
    assert.equal(summarizeFailure({ error, failureKind }), expected, String(error));
  assert.equal(summarizeFailure({ error: null, failureKind: null, prState: "CLOSED" }), "PR closed unmerged");
  assert.equal(summarizeFailure({ error: null, failureKind: null }), null);
});

test("only Failed cards carry a failure summary, from their latest attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const card = board.createCard({ title: "Fix the feed", body: "", repo: dir });
    board.setStatus(card.id, "ready");
    board.finish(board.claim(card.id).id, "failed", "Pi exited (143); Bakery sent SIGTERM: 30-minute run timeout; no settlement event");
    assert.equal(board.getCard(card.id)?.failureSummary, "Timed out after 30 min");
    board.setStatus(card.id, "ready");
    assert.equal(board.getCard(card.id)?.failureSummary, null, "a retried card no longer shows the old failure");
    board.finish(board.claim(card.id).id, "failed", "Pi could not start: spawn pi ENOENT");
    assert.equal(board.listCards().find(item => item.id === card.id)?.failureSummary, "Pi could not start");
    assert.equal("failedError" in board.getCard(card.id)!, false, "the raw error stays off the card list");
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a tool call reads as one short line, without the worktree prefix or secrets", () => {
  const worktree = "/data/worktrees/abc";
  assert.equal(describeToolCall({ command: `cd ${worktree} && npm test\n  -- --watch` }, worktree), "npm test -- --watch");
  assert.equal(describeToolCall({ path: `${worktree}/src/main.ts`, offset: 1 }, worktree), "src/main.ts");
  assert.equal(describeToolCall({ query: "x" }), '{"query":"x"}');
  assert.equal(describeToolCall(undefined), "");
  assert.equal(
    describeToolCall({ command: "export SILK_DB_TEST_URL=postgres://postgres:pw@localhost:5432/silk API_TOKEN='abc def' && psql postgres://u:secret@db/x" }),
    "export SILK_DB_TEST_URL=<redacted> API_TOKEN=<redacted> && psql postgres://<redacted>@db/x",
  );
  assert.equal(describeToolCall({ command: "x".repeat(300) }).length, 200);
});
