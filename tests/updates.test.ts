import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updates, promoteStagedUi, serverModules } from "../server/updates.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" }).trim();
}

// A checkout whose origin/main is two commits ahead, as after the update timer fetched.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alice-updates-"));
  const repo = join(dir, "repo"), remote = join(dir, "remote.git"), other = join(dir, "other");
  mkdirSync(repo);
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "one\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "Initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", remote, other);
  for (const subject of ["Add pending updates notice", "Fix typo"]) git(other, "commit", "-q", "--allow-empty", "-m", subject);
  git(other, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { repo, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lists the fetched commits newest first as the changelog", () => {
  const { repo, close } = fixture();
  try {
    const updates = new Updates(repo, async () => {}, () => {});
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Fix typo", "Add pending updates notice"]);
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    updates.refresh();
    assert.equal(updates.state.commits.length, 2, "still pending until the server restarts on them");
    const restarted = new Updates(repo, async () => {}, () => {});
    restarted.refresh();
    assert.deepEqual(restarted.state.commits, []);
  } finally { close(); }
});

test("asking to install with nothing pending is refused", () => {
  const { repo, close } = fixture();
  try {
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    const updates = new Updates(repo, async () => {}, () => {});
    assert.throws(() => updates.apply(), /Already up to date/);
  } finally { close(); }
});

// Approving a card merges its branch into the checkout's own main with a "Merge card:" commit, so HEAD moves while
// origin/main stays put.
function mergeLocally(repo: string, subject: string) {
  git(repo, "checkout", "-q", "-b", "card");
  git(repo, "commit", "-q", "--allow-empty", "-m", `Alice card: ${subject}`);
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", `Merge card: ${subject}`, "card");
  git(repo, "branch", "-q", "-D", "card");
}

test("lists commits merged into main since startup, after any from origin/main", () => {
  const { repo, close } = fixture();
  try {
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    const updates = new Updates(repo, async () => {}, () => {});
    updates.refresh();
    assert.equal(updates.state.commits.length, 0);
    mergeLocally(repo, "Approved card");
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Alice card: Approved card"], "the card once, without its merge commit");
  } finally { close(); }
});

test("combines origin/main updates with local merges, newest first", () => {
  const { repo, close } = fixture();
  try {
    const updates = new Updates(repo, async () => {}, () => {});
    mergeLocally(repo, "Approved card");
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Fix typo", "Add pending updates notice", "Alice card: Approved card"]);
  } finally { close(); }
});

// A card that went through rework lands several commits under the same subject, one per attempt.
test("lists a card's rework commits once, under the newest", () => {
  const { repo, close } = fixture();
  try {
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    const updates = new Updates(repo, async () => {}, () => {});
    git(repo, "checkout", "-q", "-b", "card");
    for (let attempt = 0; attempt < 3; attempt++) git(repo, "commit", "-q", "--allow-empty", "-m", "Alice card: Reworked card");
    const newest = git(repo, "rev-parse", "--short", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge card: Reworked card", "card");
    updates.refresh();
    assert.deepEqual(updates.state.commits, [{ sha: newest, subject: "Alice card: Reworked card" }]);
  } finally { close(); }
});

// The install builds into dist-next so a draining server keeps serving the UI that matches its API.
test("a restarted server swaps the staged UI build into dist", () => {
  const root = mkdtempSync(join(tmpdir(), "alice-ui-"));
  try {
    assert.equal(promoteStagedUi(root), false);
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "old");
    writeFileSync(join(root, "dist", "assets", "old.js"), "old");
    mkdirSync(join(root, "dist-next"));
    writeFileSync(join(root, "dist-next", "index.html"), "new");
    assert.equal(promoteStagedUi(root), true);
    assert.equal(readFileSync(join(root, "dist", "index.html"), "utf8"), "new");
    assert.equal(existsSync(join(root, "dist", "assets", "old.js")), false);
    assert.equal(existsSync(join(root, "dist-next")), false);
    assert.equal(promoteStagedUi(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A checkout with a server that imports one src module, and an origin/main one commit ahead touching `path`.
function changeFixture(path: string) {
  const dir = mkdtempSync(join(tmpdir(), "alice-updates-"));
  const repo = join(dir, "repo"), remote = join(dir, "remote.git"), other = join(dir, "other");
  mkdirSync(join(repo, "server"), { recursive: true });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "server", "index.ts"), 'import { shared } from "../src/shared.js";\n');
  writeFileSync(join(repo, "src", "shared.ts"), "export const shared = 1;\n");
  writeFileSync(join(repo, "src", "style.css"), "body {}\n");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", remote, other);
  mkdirSync(join(other, path, ".."), { recursive: true });
  writeFileSync(join(other, path), "changed\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", `Change ${path}`);
  git(other, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { repo, close: () => rmSync(dir, { recursive: true, force: true }) };
}

const fastForward = (repo: string) => async () => { git(repo, "merge", "-q", "--ff-only", "origin/main"); };

test("an update that only touches the UI swaps it in without a restart", async () => {
  const { repo, close } = changeFixture("src/style.css");
  try {
    let restarted = 0, swapped = 0;
    const updates = new Updates(repo, fastForward(repo), () => restarted++, () => swapped++);
    updates.refresh();
    const before = updates.state.ui;
    assert.equal(updates.state.restart, false);
    await updates.apply();
    assert.deepEqual([restarted, swapped], [0, 1]);
    assert.deepEqual(updates.state.commits, [], "nothing left pending");
    assert.equal(updates.state.installing, false);
    assert.notEqual(updates.state.ui, before, "open pages see a new UI build");
  } finally { close(); }
});

for (const path of ["server/worker.ts", "src/shared.ts", "package.json", "scripts/update.sh"]) {
  test(`an update touching ${path} restarts the server`, async () => {
    const { repo, close } = changeFixture(path);
    try {
      let restarted = 0, swapped = 0;
      const updates = new Updates(repo, fastForward(repo), () => restarted++, () => swapped++);
      updates.refresh();
      assert.equal(updates.state.restart, true);
      await updates.apply();
      assert.deepEqual([restarted, swapped], [1, 0]);
    } finally { close(); }
  });
}

test("a server change after a UI-only install still restarts", async () => {
  const { repo, close } = changeFixture("src/style.css");
  try {
    let restarted = 0;
    const updates = new Updates(repo, fastForward(repo), () => restarted++, () => {});
    await updates.apply();
    writeFileSync(join(repo, "server", "index.ts"), "export {};\n");
    git(repo, "commit", "-qam", "Alice card: server change");
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Alice card: server change"]);
    assert.equal(updates.state.restart, true);
    await updates.apply();
    assert.equal(restarted, 1);
  } finally { close(); }
});

test("a live UI swap keeps the old build's chunks for pages still open on it", () => {
  const root = mkdtempSync(join(tmpdir(), "alice-ui-"));
  try {
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "old");
    writeFileSync(join(root, "dist", "assets", "old.js"), "old");
    mkdirSync(join(root, "dist-next", "assets"), { recursive: true });
    writeFileSync(join(root, "dist-next", "index.html"), "new");
    writeFileSync(join(root, "dist-next", "assets", "new.js"), "new");
    assert.equal(promoteStagedUi(root, { keepOldAssets: true }), true);
    assert.equal(readFileSync(join(root, "dist", "index.html"), "utf8"), "new");
    assert.equal(readFileSync(join(root, "dist", "assets", "old.js"), "utf8"), "old");
    assert.equal(readFileSync(join(root, "dist", "assets", "new.js"), "utf8"), "new");
    assert.equal(existsSync(join(root, "dist-old")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the server's module graph includes the src files it imports and nothing else from src", () => {
  const files = serverModules(process.cwd());
  assert.ok(files.has("server/index.ts"));
  assert.ok(files.has("src/model.ts"));
  assert.ok(!files.has("src/main.tsx"));
  assert.ok(!files.has("src/style.css"));
});

test("the timer installs UI-only updates on its own and leaves restarts for the button", async () => {
  for (const [path, expected] of [["src/style.css", { swapped: 1, restarted: 0, pending: 0 }], ["server/worker.ts", { swapped: 0, restarted: 0, pending: 1 }]] as const) {
    const { repo, close } = changeFixture(path);
    try {
      let restarted = 0, swapped = 0;
      const updates = new Updates(repo, fastForward(repo), () => restarted++, () => swapped++);
      await updates.poll();
      assert.deepEqual({ swapped, restarted, pending: updates.state.commits.length }, expected, path);
    } finally { close(); }
  }
});

test("a failed automatic UI install is not retried until something new lands", async () => {
  const { repo, close } = changeFixture("src/style.css");
  try {
    let attempts = 0;
    const updates = new Updates(repo, async () => { attempts++; throw new Error("vite build failed"); }, () => {}, () => {});
    await updates.poll();
    await updates.poll();
    assert.equal(attempts, 1);
    assert.match(updates.state.error ?? "", /vite build failed/);
    writeFileSync(join(repo, "src", "style.css"), "body { color: red }\n");
    git(repo, "commit", "-qam", "Alice card: another style tweak");
    await updates.poll();
    assert.equal(attempts, 2);
  } finally { close(); }
});
