import type { ReasoningConfig, ReasoningEffort } from "../../../types/ai";

import { getModelReasoning } from "../models/reasoning";

const EFFORT_ORDER: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Anthropic models that take adaptive thinking + output_config.effort.
const ANTHROPIC_EFFORT = [
  /opus-4-[5-8]/,
  /sonnet-4-6/,
  /fable-5/,
  /mythos-5/,
  /opus-5/,
  /sonnet-5/,
];
// Anthropic models with adaptive thinking but NO effort parameter. Reserved:
// only add a model here once it's CONFIRMED to accept adaptive thinking without
// `output_config.effort`. Unconfirmed models fall through to "none" (no-op) so
// we never risk a 400 — Haiku 4.5, for instance, rejects `effort` and is not
// confirmed for adaptive, so it stays out.
const ANTHROPIC_ADAPTIVE_ONLY: RegExp[] = [];
// Anthropic models that use legacy extended thinking (budget_tokens).
const ANTHROPIC_LEGACY_THINKING = [
  /haiku-4-5/,
  /sonnet-4-5/,
  /sonnet-4-0/,
  /sonnet-4-2025/,
  /opus-4-0/,
  /opus-4-1/,
  /opus-4-2025/,
  /3-7-sonnet/,
];
// Anthropic models that REMOVED temperature/top_p/top_k (sending them 400s).
const ANTHROPIC_NO_SAMPLING = [
  /opus-4-[78]/,
  /fable-5/,
  /mythos-5/,
  /opus-5/,
  /sonnet-5/,
];
// Anthropic models that support the `max` effort tier (others clamp max→high).
const ANTHROPIC_MAX_EFFORT = [
  /opus-4-[678]/,
  /sonnet-4-6/,
  /fable-5/,
  /mythos-5/,
];
// OpenAI reasoning models (effort-capable); everything else ignores effort.
const OPENAI_REASONING = [/(^|[^a-z])o[1345](-|$)/, /gpt-[56]/];
// OpenAI reasoning models that support the `minimal` tier (others clamp →low).
const OPENAI_MINIMAL_EFFORT = [/gpt-5/];

const matches = (model: string, patterns: RegExp[]) =>
  patterns.some((pattern) => pattern.test(model));

export type AnthropicReasoningMode = "effort" | "adaptive" | "legacy" | "none";

export const anthropicReasoningMode = (
  model: string,
): AnthropicReasoningMode => {
  if (matches(model, ANTHROPIC_EFFORT)) return "effort";
  if (matches(model, ANTHROPIC_ADAPTIVE_ONLY)) return "adaptive";
  if (matches(model, ANTHROPIC_LEGACY_THINKING)) return "legacy";

  return "none";
};

/** Modern Anthropic + Fable/Mythos reject temperature/top_p/top_k entirely. */
export const anthropicSupportsSampling = (model: string) =>
  !matches(model, ANTHROPIC_NO_SAMPLING);

export const isOpenAIReasoningModel = (model: string) =>
  matches(model, OPENAI_REASONING);

// effort → legacy thinking budget (tokens). Kept under typical max_tokens; the
// Anthropic provider raises max_tokens to fit when thinking is enabled.
const EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  xhigh: 24576,
  high: 16384,
  low: 2048,
  max: 32768,
  medium: 8192,
  minimal: 1024,
};

// budget tokens → nearest effort (when a caller gave only budgetTokens but the
// target model is effort-based).
const budgetToEffort = (budget: number): ReasoningEffort => {
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 16384) return "high";

  return "max";
};

/** The portable effort a config asks for, deriving from budgetTokens if needed. */
export const resolveEffort = (
  reasoning: ReasoningConfig,
): ReasoningEffort | null => {
  if (reasoning.effort) return reasoning.effort;
  if (typeof reasoning.budgetTokens === "number") {
    return budgetToEffort(reasoning.budgetTokens);
  }

  return null;
};

/** The budget a config asks for, deriving from effort if needed. */
export const resolveBudgetTokens = (
  reasoning: ReasoningConfig,
): number | null => {
  if (typeof reasoning.budgetTokens === "number") return reasoning.budgetTokens;
  if (reasoning.effort) return EFFORT_BUDGET[reasoning.effort];

  return null;
};

const clampEffort = (
  effort: ReasoningEffort,
  allowed: ReasoningEffort[],
): ReasoningEffort => {
  if (allowed.includes(effort)) return effort;
  // Walk DOWN the order to the nearest allowed tier (never silently escalate).
  const idx = EFFORT_ORDER.indexOf(effort);
  for (let lower = idx - 1; lower >= 0; lower -= 1) {
    const candidate = EFFORT_ORDER[lower];
    if (candidate && allowed.includes(candidate)) return candidate;
  }

  return allowed[0] ?? effort;
};

/** Anthropic `output_config.effort` value for an effort-capable model, or null. */
export const anthropicEffortValue = (
  model: string,
  reasoning: ReasoningConfig,
) => {
  const effort = resolveEffort(reasoning);
  if (!effort) return null;
  const known = getModelReasoning("anthropic", model);
  if (known?.kind === "effort") return clampEffort(effort, [...known.efforts]);
  const allowed: ReasoningEffort[] = matches(model, ANTHROPIC_MAX_EFFORT)
    ? ["low", "medium", "high", "max"]
    : ["low", "medium", "high"];

  return clampEffort(effort, allowed);
};

/** OpenAI `reasoning.effort` value for a reasoning model, or null. */
export const openaiEffortValue = (
  model: string,
  reasoning: ReasoningConfig,
) => {
  if (!isOpenAIReasoningModel(model)) return null;
  const effort = resolveEffort(reasoning);
  if (!effort) return null;
  const known = getModelReasoning("openai", model);
  if (known) return clampEffort(effort, [...known.efforts]);
  const allowed: ReasoningEffort[] = matches(model, OPENAI_MINIMAL_EFFORT)
    ? ["minimal", "low", "medium", "high"]
    : ["low", "medium", "high"];
  // OpenAI has no `max`; clamp it to `high`.
  const requested = effort === "max" ? "high" : effort;

  return clampEffort(requested, allowed);
};

/** Provider-specific Chat Completions controls. Never send a guessed parameter. */
export const compatibleReasoningBody = (
  provider: string,
  model: string,
  reasoning?: ReasoningConfig,
): Record<string, unknown> => {
  if (!reasoning) return {};
  const known = getModelReasoning(provider, model);
  const effort = resolveEffort(reasoning);
  if (!known || !effort) return {};
  if (!known.efforts.includes(effort))
    throw new Error(
      `Unsupported reasoning effort ${effort} for ${provider}:${model}`,
    );
  if (provider === "alibaba")
    return effort === "none"
      ? { enable_thinking: false }
      : {
          enable_thinking: true,
          thinking_budget: resolveBudgetTokens(reasoning),
        };
  if (provider === "deepseek")
    return effort === "none"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: effort };
  return { reasoning_effort: effort };
};
export const geminiThinkingConfig = (
  model: string,
  reasoning?: ReasoningConfig,
): Record<string, unknown> | undefined => {
  if (!reasoning) return undefined;
  const profile = getModelReasoning("google", model);
  const effort = resolveEffort(reasoning);
  if (!profile || !effort) return undefined;
  if (!profile.efforts.includes(effort))
    throw new Error(`Unsupported reasoning effort ${effort} for ${model}`);
  if (profile.kind === "effort") return { thinkingLevel: effort };
  const budgets: Partial<Record<ReasoningEffort, number>> = {
    none: 0,
    low: 1024,
    medium: 8192,
    high: 24576,
  };
  return { thinkingBudget: reasoning.budgetTokens ?? budgets[effort] };
};
