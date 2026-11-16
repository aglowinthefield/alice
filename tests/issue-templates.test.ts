import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const load = (name: string) =>
  parse(readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), "utf8"));

test("blank issues are disabled", () => {
  assert.equal(load("config.yml").blank_issues_enabled, false);
});

for (const name of ["bug.yml", "feature.yml"]) {
  test(`${name} is a valid issue form`, () => {
    const form = load(name);
    assert.ok(form.name && form.description);
    const ids = new Set<string>();
    for (const item of form.body) {
      if (item.type === "markdown") continue;
      assert.ok(item.id && !ids.has(item.id));
      ids.add(item.id);
      assert.ok(item.attributes.label);
    }
    assert.ok(ids.size > 0);
  });
}

test("bug form asks for the diagnostics and warns about secrets", () => {
  const form = load("bug.yml");
  const ids = form.body.map((b: { id?: string }) => b.id);
  for (const id of ["what-happened", "expected", "steps", "version", "os", "doctor", "logs"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.match(form.body[0].attributes.value, /secrets/);
});

test("README links the bug template", () => {
  assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /ISSUE_TEMPLATE\/bug\.yml/);
});
