import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `git` for the front of PATH that holds chosen commands until the test releases them, and runs real Git for
 * everything else. Each rule matches a substring of the arguments (`-C <path> ...`, so use canonical paths, as the
 * server does). A held command logs that it started and waits on a file, never on a timer. POSIX shells only.
 */
export type HoldRule = { name: string; match: string; withoutIndexFile?: boolean; withIndexFile?: boolean };
export function fakeGit(dir: string, rules: HoldRule[]) {
  const bin = join(dir, "fake-git-bin");
  mkdirSync(bin, { recursive: true });
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const file = (name: string, kind: string) => join(dir, `fake-git-${name}.${kind}`);
  const cases = rules.map(rule => `case "$*" in *'${rule.match}'*)
  if ${rule.withoutIndexFile ? '[ -z "$GIT_INDEX_FILE" ]' : rule.withIndexFile ? '[ -n "$GIT_INDEX_FILE" ]' : "true"}; then
    echo "$*" >> '${file(rule.name, "log")}'
    : > '${file(rule.name, "waiting")}'
    while [ ! -f '${file(rule.name, "release")}' ]; do sleep 0.02; done
  fi ;;
esac`).join("\n");
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${cases}\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return {
    bin,
    /** True once a held command has started and is waiting. */
    waiting: (name: string) => existsSync(file(name, "waiting")),
    /** Lets every held command for `name`, now and later, run. */
    release: (name: string) => writeFileSync(file(name, "release"), ""),
    /** How many commands matched `name`. */
    count: (name: string) => existsSync(file(name, "log")) ? readFileSync(file(name, "log"), "utf8").split("\n").filter(Boolean).length : 0,
    releaseAll: () => { for (const rule of rules) writeFileSync(file(rule.name, "release"), ""); },
  };
}

/** Puts `bin` first on this process's PATH for the length of `work`, so Git this process spawns goes through it. */
export async function withPath<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try { return await work(); } finally { process.env.PATH = before; }
}

/** Polls `check` every 25 ms until it holds; the deadline only bounds a failure. */
export async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
