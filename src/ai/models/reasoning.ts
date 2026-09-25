import type { ReasoningEffort } from "../../../types/ai";

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningSelection = "auto" | ReasoningEffort;
export type ModelReasoning = {
  kind: "effort" | "budget" | "fixed";
  efforts: readonly ReasoningEffort[];
  description: string;
  source: string;
};
export const isReasoningSelection = (
  value: unknown,
): value is ReasoningSelection =>
  value === "auto" || REASONING_EFFORTS.some((effort) => effort === value);
const profile = (
  kind: ModelReasoning["kind"],
  efforts: readonly ReasoningEffort[],
  description: string,
  source: string,
): ModelReasoning => ({ kind, efforts, description, source });
const claude = profile(
  "effort",
  ["low", "medium", "high", "xhigh", "max"],
  "More thinking for harder problems; higher settings can take longer and use more credits.",
  "https://platform.claude.com/docs/en/build-with-claude/effort",
);
const claude46 = {
  ...claude,
  efforts: ["low", "medium", "high", "max"] as const,
};
const opus45 = { ...claude, efforts: ["low", "medium", "high"] as const };
const haiku = profile(
  "budget",
  ["none", "low", "medium", "high"],
  "Thinking-token budget: Low 2,048; Medium 8,192; High 16,384. Actual usage can be lower.",
  "https://platform.claude.com/docs/en/build-with-claude/extended-thinking",
);
const gpt = profile(
  "effort",
  ["none", "low", "medium", "high", "xhigh", "max"],
  claude.description,
  "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
);
const gemini = profile(
  "effort",
  ["low", "medium", "high"],
  claude.description,
  "https://ai.google.dev/gemini-api/docs/openai",
);
const deepseek = profile(
  "effort",
  ["none", "low", "high", "max"],
  claude.description,
  "https://api-docs.deepseek.com/guides/thinking_mode/",
);
const mistral = profile(
  "effort",
  ["none", "high"],
  "Minimal thinking or full reasoning. This model does not offer intermediate effort levels.",
  "https://docs.mistral.ai/studio/conversations/reasoning",
);
const qwen = profile(
  "budget",
  ["none", "low", "medium", "high"],
  haiku.description,
  "https://help.aliyun.com/en/model-studio/deep-thinking",
);
/** Exact reviewed IDs; unknown models expose only the provider default. Reviewed 2026-09-20;
 * Anthropic effort levels re-checked against the Models API 2026-09-25. */
export const MODEL_REASONING: Readonly<Record<string, ModelReasoning>> = {
  "anthropic:claude-opus-5-5": claude,
  "anthropic:claude-fable-5-1": claude,
  "anthropic:claude-opus-5": claude,
  "anthropic:claude-sonnet-5": claude,
  "anthropic:claude-fable-5": claude,
  "anthropic:claude-opus-4-8": claude,
  "anthropic:claude-opus-4-7": claude,
  "anthropic:claude-sonnet-4-6": claude46,
  "anthropic:claude-opus-4-6": claude46,
  "anthropic:claude-opus-4-5": opus45,
  "anthropic:claude-haiku-4-5": haiku,
  "anthropic:claude-sonnet-4-5": haiku,
  "openai:gpt-6-astra": {
    ...gpt,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
  },
  "openai:gpt-5.6-sol": gpt,
  "openai:gpt-5.6-terra": gpt,
  "openai:gpt-5.6-luna": gpt,
  "google:gemini-3.8-flash": gemini,
  "google:gemini-3.1-pro-preview": gemini,
  "google:gemini-2.5-flash": profile(
    "budget",
    ["none", "low", "medium", "high"],
    "Thinking-token budget: Low 1,024; Medium 8,192; High 24,576.",
    gemini.source,
  ),
  "xai:grok-4.6": profile(
    "effort",
    ["low", "medium", "high", "xhigh"],
    "Always reasons. Choose how much thinking it should do.",
    "https://docs.x.ai/developers/model-capabilities/text/reasoning",
  ),
  "deepseek:deepseek-flash": deepseek,
  "deepseek:deepseek-v4-pro": deepseek,
  "mistral:mistral-medium-3-5": mistral,
  "mistral:mistral-small-latest": mistral,
  "alibaba:qwen3.8-max": qwen,
  "alibaba:qwen3.7-plus": qwen,
  "moonshot:kimi-k3": profile(
    "effort",
    ["low", "high", "max"],
    "Always reasons. Choose how much thinking it should do.",
    "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
  ),
  "moonshot:kimi-k2.7-code": profile(
    "fixed",
    [],
    "Thinking is always enabled; this model has no documented adjustable effort control.",
    "https://www.kimi.ai/resources/kimi-k2-7-code",
  ),
};
export const getModelReasoning = (
  provider: string,
  model: string,
): ModelReasoning | undefined => MODEL_REASONING[`${provider}:${model}`];
export const supportsReasoningSelection = (
  provider: string,
  model: string,
  selection: ReasoningSelection,
): boolean =>
  selection === "auto" ||
  Boolean(getModelReasoning(provider, model)?.efforts.includes(selection));
export const reasoningSelectionLabel = (
  selection: ReasoningSelection,
  provider?: string,
): string => {
  if (selection === "auto") return "Auto";
  if (selection === "none") return provider === "mistral" ? "Minimal" : "Off";
  if (selection === "xhigh") return "Extra high";
  return selection.charAt(0).toUpperCase() + selection.slice(1);
};
