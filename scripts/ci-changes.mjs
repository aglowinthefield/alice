#!/usr/bin/env node
// Decides which `test` jobs a pull request needs. `.github/workflows/ci.yml` runs it on the PR's merge commit and
// reads `test` and `os` from its output. Pushes to main skip it and run the full matrix.
//
//   node scripts/ci-changes.mjs            compares HEAD with its first parent (the base branch)
//   node scripts/ci-changes.mjs a.md b.ts  classifies the given paths
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Changes that cannot affect what the tests check.
const docsOnly = [/\.md$/i, /^docs\//, /^\.github\/ISSUE_TEMPLATE\//];

// Code that behaves differently on macOS: platform shims, spawning processes and creating worktrees, and the UI,
// which the tests drive in WebKit only on macOS (tests/setup.ts), with shared/, which the UI bundles. Their tests and the CI setup count too.
// These server modules spawn child processes or handle worktrees; a test file named after one (`chat.test.ts`,
// `chat-images.test.ts`) counts with it.
const processModules = [
  "platform", "auto-review", "board", "chat", "discuss", "github", "index", "integration", "lock", "origin-main",
  "origin", "pr-draft", "shared-cache-env",
  "turbo-summary", "updates", "worker",
];
// Tests that launch Playwright without the `-ui.test.ts` suffix (grep -l playwright tests/*.ts).
const browserTests = [
  "attempt-path", "compline-theme", "density", "lane-status", "repo-appearance", "review-navigation",
  "review-notification", "theme",
];
const macosSensitive = [
  new RegExp(`^server/(${processModules.join("|")})\\.ts$`),
  new RegExp(`^tests/(${processModules.join("|")})(-[\\w-]+)?\\.test\\.ts$`),
  new RegExp(`^tests/(${browserTests.join("|")})\\.test\\.ts$`),
  /^src\//,
  /^shared\//,
  /^public\//,
  /^index\.html$/,
  /^vite\.config\.ts$/,
  /^tests\/[\w-]+-ui\.test\.ts$/,
  /^tests\/setup\.ts$/,
  /^desktop\//,
  /^src-tauri\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-changes\.mjs$/,
];

const linux = "ubuntu-latest";
const macos = "macos-latest";

/** Whether `test` runs for these changed paths, and on which runners. */
export function plan(files) {
  // No diff to go on means we can't tell what changed, so test everywhere.
  if (!files.length) return { test: true, os: [linux, macos] };
  if (files.every((file) => docsOnly.some((pattern) => pattern.test(file)))) return { test: false, os: [] };
  const needsMacos = files.some((file) => macosSensitive.some((pattern) => pattern.test(file)));
  return { test: true, os: needsMacos ? [linux, macos] : [linux] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const files = given.length
    ? given
    : execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const result = plan(files);
  console.error(`${files.length} changed file(s): ${result.test ? `test on ${result.os.join(", ")}` : "no tests needed"}`);
  console.log(`test=${result.test}`);
  console.log(`os=${JSON.stringify(result.os)}`);
}
