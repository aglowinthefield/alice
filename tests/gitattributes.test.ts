import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unionMergeLine } from "../src/gitattributes.js";

// Git is the judge: each suggested line must give merge=union to its own file and to no other path.
test("the suggested merge=union line matches exactly its file, whatever the name holds", () => {
  const repo = mkdtempSync(join(tmpdir(), "alice-gitattributes-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    const files = ["README.md", "docs/agent-map/api.md", "notes ü.md", "a b.md", "weird[1]*?.md", 'say "hi".md', "back\\slash.md"];
    writeFileSync(join(repo, ".gitattributes"), files.map(unionMergeLine).join("\n") + "\n");
    const merge = (path: string) => execFileSync("git", ["-C", repo, "check-attr", "-z", "merge", "--", path], { encoding: "utf8" }).split("\0")[2];
    for (const file of files) assert.equal(merge(file), "union", `${file}: ${unionMergeLine(file)}`);
    for (const other of ["docs/README.md", "weird1x.md", "a", "b.md", "docs/agent-map/other.md", "sub/notes ü.md"])
      assert.equal(merge(other), "unspecified", other);
    assert.equal(unionMergeLine("docs/agent-map/api.md"), "/docs/agent-map/api.md merge=union", "a plain path stays readable");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
