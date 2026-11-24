import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error plain .mjs script without types
import { plan } from "../scripts/ci-changes.mjs";

const linux = "ubuntu-latest", macos = "macos-latest";

test("docs, Markdown and issue templates alone skip the tests", () => {
  assert.deepEqual(plan(["README.md", "docs/desktop.md", ".github/ISSUE_TEMPLATE/bug.yml"]), { test: false, os: [] });
});

test("a test and a dev dependency run on Linux only", () => {
  assert.deepEqual(plan(["README.md", "tests/stats.test.ts", "package.json", "package-lock.json"]), { test: true, os: [linux] });
});

test("OS-sensitive code adds macOS", () => {
  for (const file of ["server/platform.ts", "server/worker.ts", "server/integration.ts", "src/review.tsx", "desktop/index.html", "src-tauri/Cargo.toml", "tests/chat-ui.test.ts"]) {
    assert.deepEqual(plan(["README.md", file]), { test: true, os: [linux, macos] }, file);
  }
});

test("a change to the CI plan itself runs everywhere, and an empty diff is not skipped", () => {
  assert.deepEqual(plan([".github/workflows/ci.yml"]), { test: true, os: [linux, macos] });
  assert.deepEqual(plan([]), { test: true, os: [linux, macos] });
});

test("every server module that spawns processes selects macOS, and so do its tests", () => {
  for (const file of ["server/chat.ts", "server/auto-review.ts", "server/github.ts", "server/discuss.ts", "server/pr-draft.ts", "server/board.ts", "server/sentinel.ts", "tests/chat.test.ts", "tests/auto-review.test.ts", "tests/github-pr.test.ts", "tests/discuss.test.ts", "tests/pr-draft.test.ts"]) {
    assert.deepEqual(plan([file]), { test: true, os: [linux, macos] }, file);
  }
});

test("Playwright tests without the -ui suffix select macOS", () => {
  for (const file of ["tests/density.test.ts", "tests/theme.test.ts", "tests/review-navigation.test.ts", "tests/review-notification.test.ts", "tests/lane-status.test.ts"]) {
    assert.deepEqual(plan([file]), { test: true, os: [linux, macos] }, file);
  }
});

test("every test file that imports Playwright selects macOS", () => {
  for (const name of readdirSync(new URL("./", import.meta.url))) {
    if (!name.endsWith(".ts") || name === "ci-changes.test.ts") continue;
    if (!readFileSync(new URL(name, import.meta.url), "utf8").includes('"playwright"')) continue;
    assert.deepEqual(plan([`tests/${name}`]), { test: true, os: [linux, macos] }, name);
  }
});
