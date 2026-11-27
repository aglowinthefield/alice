import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelLister } from "../server/pi-models.js";

const table = "printf '%s\\n' 'provider  model  context' 'anthropic  claude-sonnet-4-5  200K'";
function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-pi-models-")), pi = join(dir, "pi"), leftover = join(dir, "leftover.pid");
  writeFileSync(pi, `#!/bin/sh\n${body.replaceAll("LEFTOVER", leftover)}\n`);
  chmodSync(pi, 0o755);
  return {
    pi, close: () => {
      if (existsSync(leftover)) try { process.kill(Number(readFileSync(leftover, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a model list that failed before Pi started is not served again: the next request runs Pi", async () => {
  const f = fixture(table);
  const realMkdir = fs.mkdirSync;
  let failures = 1;
  const mkdir = mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (String(args[0]).includes("bakery-run-") && failures-- > 0) throw Object.assign(new Error("ENOSPC: no space left on device, mkdir"), { code: "ENOSPC" });
    return realMkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    const list = modelLister(f.pi);
    assert.deepEqual(await list(), { models: [], error: "Could not list Pi models: ENOSPC: no space left on device, mkdir" });
    assert.deepEqual(await list(), { models: ["anthropic/claude-sonnet-4-5"] });
  } finally { mkdir.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

test("more than 4 MB on stderr fails the list, as on stdout, even when Pi then exits cleanly", async () => {
  const f = fixture(`head -c 4000001 /dev/zero >&2\n${table}`);
  try { assert.deepEqual(await modelLister(f.pi)(), { models: [], error: "Could not list Pi models: error output exceeded 4 MB" }); }
  finally { f.close(); }
});

test("an overflowing or timed-out list answers at once even while a leftover tool holds Pi's pipes open", async () => {
  const flood = fixture("sleep 30 &\necho $! > 'LEFTOVER'\nhead -c 4000001 /dev/zero\nexec sleep 30");
  try { assert.deepEqual(await modelLister(flood.pi)(), { models: [], error: "Could not list Pi models: output exceeded 4 MB" }); }
  finally { flood.close(); }
  const stuck = fixture("sleep 30 &\necho $! > 'LEFTOVER'\nexec sleep 30");
  try { assert.deepEqual(await modelLister(stuck.pi, 300)(), { models: [], error: "Could not list Pi models: timed out" }); }
  finally { stuck.close(); }
});
