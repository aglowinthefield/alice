import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyAgentModels, parseAgentModels, parseBoardAgentModels, parseModelList, piModelArgs, resolveAgentModel, validateAgentModels, validateBoardAgentModels } from "../shared/agent-models.js";

test("agent model input fills missing phases and rejects unknown phases, flags, and thinking levels", () => {
  assert.deepEqual(validateAgentModels({}), emptyAgentModels());
  assert.deepEqual(validateAgentModels({ review: { model: " openai-codex/gpt-5.5 ", thinking: "high" }, work: { thinking: "off" } }),
    { ...emptyAgentModels(), review: { model: "openai-codex/gpt-5.5", thinking: "high" }, work: { model: "", thinking: "off" } });
  assert.equal(validateAgentModels({ work: { model: "sonnet:high" } }).work.model, "sonnet:high");
  for (const input of [null, [], "x", { deploy: {} }, { work: "anthropic/x" }, { work: { model: "a", extra: 1 } },
    { work: { model: "--help" } }, { work: { model: "-x" } }, { work: { model: "has space" } }, { work: { model: "a;rm" } },
    { work: { model: "a".repeat(201) } }, { work: { model: 5 } }, { work: { thinking: "huge" } }, { work: { thinking: null } }])
    assert.throws(() => validateAgentModels(input), /agentModels|agent phase/, JSON.stringify(input));
  assert.deepEqual(parseAgentModels("not json"), emptyAgentModels());
  assert.deepEqual(parseAgentModels('{"conflict":{"model":"anthropic/claude-sonnet-4-5","thinking":""}}').conflict.model, "anthropic/claude-sonnet-4-5");
});

test("repository values override global values per field, and only set fields become Pi flags", () => {
  const global = validateAgentModels({ work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, review: { thinking: "high" } });
  const repo = validateAgentModels({ work: { model: "openai-codex/gpt-5.5" }, conflict: { thinking: "low" } });
  assert.deepEqual(resolveAgentModel("work", repo, global), { model: "openai-codex/gpt-5.5", thinking: "medium" });
  assert.deepEqual(resolveAgentModel("conflict", repo, global), { model: "", thinking: "low" });
  assert.deepEqual(resolveAgentModel("review", repo, global), { model: "", thinking: "high" });
  assert.deepEqual(resolveAgentModel("review", undefined, emptyAgentModels()), { model: "", thinking: "" });
  assert.deepEqual(piModelArgs({ model: "", thinking: "" }), []);
  assert.deepEqual(piModelArgs({ model: "", thinking: "high" }), ["--thinking", "high"]);
  assert.deepEqual(piModelArgs({ model: "openai-codex/gpt-5.5", thinking: "xhigh" }), ["--model", "openai-codex/gpt-5.5", "--thinking", "xhigh"]);
});

test("a board's retry model applies to card runs from attempt 2, and without one every attempt is the same", () => {
  const global = validateAgentModels({ work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" } });
  const off = validateBoardAgentModels({ work: { thinking: "high" } });
  assert.equal("retry" in off, false);
  for (const attempt of [1, 2, 5]) assert.deepEqual(resolveAgentModel("work", off, global, attempt), { model: "anthropic/claude-sonnet-4-5", thinking: "high" });
  assert.deepEqual(resolveAgentModel("work", undefined, global, 3), { model: "anthropic/claude-sonnet-4-5", thinking: "medium" });

  const ladder = validateBoardAgentModels({ retry: { model: " anthropic/claude-opus-4-1 " } });
  assert.deepEqual(ladder.retry, { model: "anthropic/claude-opus-4-1", thinking: "" });
  assert.deepEqual(resolveAgentModel("work", ladder, global), { model: "anthropic/claude-sonnet-4-5", thinking: "medium" });
  assert.deepEqual(resolveAgentModel("work", ladder, global, 1), { model: "anthropic/claude-sonnet-4-5", thinking: "medium" });
  assert.deepEqual(resolveAgentModel("work", ladder, global, 2), { model: "anthropic/claude-opus-4-1", thinking: "medium" });
  assert.deepEqual(resolveAgentModel("work", ladder, global, 4), { model: "anthropic/claude-opus-4-1", thinking: "medium" });
  assert.deepEqual(resolveAgentModel("conflict", ladder, global, 2), { model: "", thinking: "" });
  assert.deepEqual(resolveAgentModel("work", validateBoardAgentModels({ retry: { thinking: "xhigh" } }), global, 2), { model: "anthropic/claude-sonnet-4-5", thinking: "xhigh" });

  // A blank rung turns the ladder off; global settings have no ladder.
  assert.equal("retry" in validateBoardAgentModels({ retry: { model: " ", thinking: "" } }), false);
  for (const input of [{ retry: "x" }, { retry: { model: "--help" } }, { retry: { thinking: "huge" } }, []])
    assert.throws(() => validateBoardAgentModels(input), /agentModels/, JSON.stringify(input));
  assert.throws(() => validateAgentModels({ retry: { model: "anthropic/claude-opus-4-1" } }), /agent phase/);
  assert.deepEqual(parseBoardAgentModels(JSON.stringify(ladder)), ladder);
  assert.deepEqual(parseBoardAgentModels("not json"), emptyAgentModels());
});

test("pi --list-models output becomes provider/model strings", () => {
  const output = `provider     model                     context  max-out  thinking  images
anthropic    claude-sonnet-4-5         200K     64K      yes       yes
openai-codex gpt-5.5                   400K     128K     yes       yes
anthropic    claude-sonnet-4-5         200K     64K      yes       yes

`;
  assert.deepEqual(parseModelList(output), ["anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.5"]);
  assert.deepEqual(parseModelList(""), []);
});
