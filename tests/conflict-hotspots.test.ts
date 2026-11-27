import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, conflictHotspotDays } from "../server/board.js";

const withBoard = (run: (board: Board, dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "alice-test-"));
  const board = new Board(join(dir, "board.sqlite"));
  try { run(board, dir); } finally { board.close(); rmSync(dir, { recursive: true, force: true }); }
};
const day = 86_400_000;

test("a file conflicting on three distinct cards becomes a hotspot on its own board only", () => withBoard((board, dir) => {
  const other = join(dir, "other");
  const [a, b, c] = ["A", "B", "C"].map(title => board.createCard({ title, body: "", repo: dir }));
  const elsewhere = board.createCard({ title: "Elsewhere", body: "", repo: other });
  board.recordMergeFailure(a.id, ["docs/agent-map/api.md", "allowlist.txt"], "conflict");
  // The same card conflicting again, and the file listed twice, still count as one card.
  board.recordMergeFailure(a.id, ["docs/agent-map/api.md", "docs/agent-map/api.md"], "conflict");
  board.recordMergeFailure(b.id, ["docs/agent-map/api.md"], "conflict");
  board.recordMergeFailure(elsewhere.id, ["docs/agent-map/api.md"], "conflict");
  assert.deepEqual(board.conflictHotspots(), {}, "two cards on this board, one on another: below the threshold");

  board.recordMergeFailure(c.id, ["docs/agent-map/api.md", "allowlist.txt"], "conflict");
  const hotspots = board.conflictHotspots();
  assert.deepEqual(Object.keys(hotspots), [dir]);
  assert.equal(hotspots[dir].length, 1, "allowlist.txt conflicted on only two cards");
  assert.equal(hotspots[dir][0].file, "docs/agent-map/api.md");
  assert.equal(hotspots[dir][0].cards, 3);
  assert.deepEqual([...hotspots[dir][0].cardIds].sort(), [a.id, b.id, c.id].sort());

  // Resolving the cards' conflicts does not erase the history the count reads.
  for (const card of [a, b, c]) board.clearMergeFailure(card.id);
  assert.equal(board.conflictHotspots()[dir]?.[0].cards, 3);
}));

test("only conflicts within the window count", () => withBoard((board, dir) => {
  const cards = ["A", "B", "C"].map(title => board.createCard({ title, body: "", repo: dir }));
  for (const card of cards) board.recordMergeFailure(card.id, ["allowlist.txt"], "conflict");
  const later = (days: number) => new Date(Date.now() + days * day);
  assert.equal(board.conflictHotspots(later(conflictHotspotDays - 1))[dir]?.[0].cards, 3);
  assert.deepEqual(board.conflictHotspots(later(conflictHotspotDays + 1)), {});
  assert.deepEqual(board.conflictHotspots(later(-1)), {}, "conflicts after `at` are not counted");
}));

test("dismissing a hotspot hides it until the file conflicts again", () => withBoard((board, dir) => {
  const [a, b, c] = ["A", "B", "C"].map(title => board.createCard({ title, body: "", repo: dir }));
  for (const card of [a, b, c]) board.recordMergeFailure(card.id, ["allowlist.txt", "docs/agent-map/api.md"], "conflict");
  board.dismissConflictHotspot(dir, "allowlist.txt");
  assert.deepEqual(board.conflictHotspots()[dir].map(item => item.file), ["docs/agent-map/api.md"], "only the dismissed file is hidden");

  board.recordMergeFailure(a.id, ["docs/agent-map/api.md"], "conflict");
  assert.equal(board.conflictHotspots()[dir].some(item => item.file === "allowlist.txt"), false, "another file's conflict does not bring it back");

  board.recordMergeFailure(b.id, ["allowlist.txt"], "conflict");
  assert.equal(board.conflictHotspots()[dir].some(item => item.file === "allowlist.txt"), true, "a new conflict on the file shows it again");

  assert.throws(() => board.dismissConflictHotspot(dir, "never-conflicted.txt"), /No conflicts recorded/);
}));
