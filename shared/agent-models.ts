export const agentPhases = ["work", "conflict", "review", "draft"] as const;
export type AgentPhase = (typeof agentPhases)[number];
export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
/** "" inherits the next level: repository → global → Pi's own default. */
export type AgentModel = { model: string; thinking: ThinkingLevel | "" };
export type AgentModels = Record<AgentPhase, AgentModel>;
/**
 * A board's choices plus an optional model ladder: attempt 1 of a card run uses `work`, and later attempts (after a
 * failure, send-back or CI fix) use `retry`. Absent means off, so every attempt uses `work`. Blank `retry` fields
 * inherit from `work`.
 */
export type BoardAgentModels = AgentModels & { retry?: AgentModel };

export const emptyAgentModels = (): AgentModels => ({
  work: { model: "", thinking: "" },
  conflict: { model: "", thinking: "" },
  review: { model: "", thinking: "" },
  draft: { model: "", thinking: "" },
});
/** Board chats default to a cheap model so casual questions cost little; each chat can pick another. */
export const defaultChatModel: AgentModel = {
  model: "openai/gpt-6.1-sol",
  thinking: "low",
};
// No spaces or leading "-": the value becomes a Pi CLI argument and must never read as a flag.
const modelPattern = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]*$/;

/** Validates one model choice from API input. Missing fields inherit; anything unknown or malformed throws. */
export function validateAgentModel(value: unknown, label: string): AgentModel {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "model" && key !== "thinking")
  )
    throw new Error(`${label} must be an object with model and thinking`);
  const { model = "", thinking = "" } = value as Record<string, unknown>;
  if (
    typeof model !== "string" ||
    model.trim().length > 200 ||
    (model.trim() && !modelPattern.test(model.trim()))
  )
    throw new Error(
      `${label}.model must be a Pi model pattern such as anthropic/claude-sonnet-4-5 (maximum 200 characters, no spaces)`,
    );
  if (thinking !== "" && !thinkingLevels.includes(thinking as ThinkingLevel))
    throw new Error(
      `${label}.thinking must be empty or one of ${thinkingLevels.join(", ")}`,
    );
  return { model: model.trim(), thinking: thinking as AgentModel["thinking"] };
}

/** Validates API input. Missing phases or fields inherit; anything unknown or malformed throws. */
export function validateAgentModels(input: unknown): AgentModels {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("agentModels must be an object");
  const result = emptyAgentModels();
  for (const [phase, value] of Object.entries(input)) {
    if (!agentPhases.includes(phase as AgentPhase))
      throw new Error(`Unknown agent phase: ${phase}`);
    result[phase as AgentPhase] = validateAgentModel(
      value,
      `agentModels.${phase}`,
    );
  }
  return result;
}

/** Validates a board's choices, which may also hold the retry rung of the model ladder. An all-blank rung turns it off. */
export function validateBoardAgentModels(input: unknown): BoardAgentModels {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("agentModels must be an object");
  const { retry, ...phases } = input as Record<string, unknown>;
  const result: BoardAgentModels = validateAgentModels(phases);
  if (retry === undefined) return result;
  const rung = validateAgentModel(retry, "agentModels.retry");
  return rung.model || rung.thinking ? { ...result, retry: rung } : result;
}

/** Reads a stored column. A corrupt value falls back to inheriting rather than blocking every run. */
export function parseAgentModels(stored: string): AgentModels {
  try {
    return validateAgentModels(JSON.parse(stored));
  } catch {
    return emptyAgentModels();
  }
}

export function parseBoardAgentModels(stored: string): BoardAgentModels {
  try {
    return validateBoardAgentModels(JSON.parse(stored));
  } catch {
    return emptyAgentModels();
  }
}

/** `attempt` is the run's attempt number; only card runs past the first climb the board's ladder. */
export function resolveAgentModel(
  phase: AgentPhase,
  repo: BoardAgentModels | undefined,
  global: AgentModels,
  attempt = 1,
): AgentModel {
  const choice: AgentModel = {
    model: repo?.[phase].model || global[phase].model,
    thinking: repo?.[phase].thinking || global[phase].thinking,
  };
  const rung = phase === "work" && attempt > 1 ? repo?.retry : undefined;
  return rung
    ? {
        model: rung.model || choice.model,
        thinking: rung.thinking || choice.thinking,
      }
    : choice;
}

/** Pi flags for a resolved choice; placed before "--" so the prompt stays positional. */
export function piModelArgs(choice: AgentModel): string[] {
  return [
    ...(choice.model ? ["--model", choice.model] : []),
    ...(choice.thinking ? ["--thinking", choice.thinking] : []),
  ];
}

/** Parses `pi --list-models` table output into provider/model strings. */
export function parseModelList(output: string): string[] {
  const models = new Set<string>();
  for (const line of output.split("\n")) {
    const [provider, model] = line.trim().split(/\s+/);
    if (
      !provider ||
      !model ||
      (provider === "provider" && model === "model") ||
      !modelPattern.test(`${provider}/${model}`)
    )
      continue;
    models.add(`${provider}/${model}`);
  }
  return [...models];
}
