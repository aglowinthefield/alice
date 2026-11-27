import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyEnv, dataDir } from "../server/legacy-names.js";
import { parseLock } from "../server/pr-lock.js";
import { parsePlan } from "../src/plan.js";

test("BAKERY_* settings fill their ALICE_* names, and an ALICE_* setting wins", () => {
  const env: NodeJS.ProcessEnv = { BAKERY_PORT: "4317", BAKERY_HOST: "old", ALICE_HOST: "new", PATH: "/bin" };
  adoptLegacyEnv(env);
  assert.equal(env.ALICE_PORT, "4317");
  assert.equal(env.ALICE_HOST, "new");
  assert.equal(env.BAKERY_PORT, "4317", "the old name stays for child processes that still read it");
});

test("the data dir stays in ~/.local/share/bakery when it exists, else moves to alice", () => {
  const home = mkdtempSync(join(tmpdir(), "alice-home-"));
  const saved = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.equal(dataDir({ BAKERY_DATA_DIR: "/data" }), "/data");
    assert.equal(dataDir({ ALICE_DATA_DIR: "/new", BAKERY_DATA_DIR: "/old" }), "/new");
    assert.equal(dataDir({}), join(home, ".local", "share", "alice"));
    mkdirSync(join(home, ".local", "share", "bakery"), { recursive: true });
    assert.equal(dataDir({}), join(home, ".local", "share", "bakery"));
  } finally {
    process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test("plan blocks and PR lock comments are read under either name", () => {
  for (const name of ["alice", "bakery"]) {
    const fence = "```";
    const plan = parsePlan(`Report\n\n${fence}${name}-plan\n[{"id":"a","title":"A","body":"B"}]\n${fence}\n`);
    assert.ok(plan && "subtasks" in plan, name);
    assert.equal(parseLock(`<!-- ${name}-lock {"holder":"x","startedAt":"2026-11-26T10:00:00Z"} -->`)?.holder, "x", name);
  }
});
