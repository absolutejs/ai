import type {
  AIProviderConfig,
  AIProviderStreamParams,
} from "../../../types/ai";
import {
  AIInputError,
  capacityJson,
  inputTokenCount,
  positiveTokenLimit,
  type AIModelLimits,
} from "../inputCapacity";

// Exact IDs only: new variants/snapshots must not inherit a guessed context size.
// Sources verified 2026-09-15: https://developers.openai.com/api/docs/models/{id}
const LIMITS: Record<string, AIModelLimits> = {
  "gpt-4.1": {
    maxInputTokens: 1047576,
    contextWindowTokens: 1047576,
    maxOutputTokens: 32768,
  },
  "gpt-4.1-2025-04-14": {
    maxInputTokens: 1047576,
    contextWindowTokens: 1047576,
    maxOutputTokens: 32768,
  },
  "gpt-4.1-mini": {
    maxInputTokens: 1047576,
    contextWindowTokens: 1047576,
    maxOutputTokens: 32768,
  },
  "gpt-4.1-mini-2025-04-14": {
    maxInputTokens: 1047576,
    contextWindowTokens: 1047576,
    maxOutputTokens: 32768,
  },
  "gpt-4.1-nano": {
    maxInputTokens: 1047576,
    contextWindowTokens: 1047576,
    maxOutputTokens: 32768,
  },
  "gpt-4.1-nano-2025-04-14": {
    maxInputTokens: 1047576,
    contextWindowTokens: 1047576,
    maxOutputTokens: 32768,
  },
  "gpt-4o": {
    maxInputTokens: 128000,
    contextWindowTokens: 128000,
    maxOutputTokens: 16384,
  },
  "gpt-4o-mini": {
    maxInputTokens: 128000,
    contextWindowTokens: 128000,
    maxOutputTokens: 16384,
  },
  "gpt-4o-mini-2024-07-18": {
    maxInputTokens: 128000,
    contextWindowTokens: 128000,
    maxOutputTokens: 16384,
  },
  "gpt-5": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5-mini": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5-mini-2025-08-07": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5-nano": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5-nano-2025-08-07": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.4-mini": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.4-nano": {
    maxInputTokens: 272000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.1": {
    maxInputTokens: 400000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.1-2025-11-13": {
    maxInputTokens: 400000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.2": {
    maxInputTokens: 400000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.2-2025-12-11": {
    maxInputTokens: 400000,
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
  },
  "gpt-5.4": {
    maxInputTokens: 1050000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  "gpt-5.4-2026-03-05": {
    maxInputTokens: 1050000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  "gpt-5.5": {
    maxInputTokens: 1050000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  "gpt-6-astra": {
    maxInputTokens: 922000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  "gpt-5.6-sol": {
    maxInputTokens: 922000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  "gpt-5.6-terra": {
    maxInputTokens: 922000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  "gpt-5.6-luna": {
    maxInputTokens: 922000,
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  },
  o3: {
    maxInputTokens: 200000,
    contextWindowTokens: 200000,
    maxOutputTokens: 100000,
  },
  "o3-2025-04-16": {
    maxInputTokens: 200000,
    contextWindowTokens: 200000,
    maxOutputTokens: 100000,
  },
  "o4-mini": {
    maxInputTokens: 200000,
    contextWindowTokens: 200000,
    maxOutputTokens: 100000,
  },
  "o4-mini-2025-04-16": {
    maxInputTokens: 200000,
    contextWindowTokens: 200000,
    maxOutputTokens: 100000,
  },
  "gpt-5-chat-latest": {
    maxInputTokens: 128000,
    contextWindowTokens: 128000,
    maxOutputTokens: 16384,
  },
  "gpt-5.1-chat-latest": {
    maxInputTokens: 128000,
    contextWindowTokens: 128000,
    maxOutputTokens: 16384,
  },
  "gpt-5.2-chat-latest": {
    maxInputTokens: 128000,
    contextWindowTokens: 128000,
    maxOutputTokens: 16384,
  },
};
export const openaiInputCapacity = (config: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  key: () => Promise<string>;
  headers: (params: AIProviderStreamParams) => Promise<HeadersInit>;
  body: (params: AIProviderStreamParams) => Record<string, unknown>;
  /** For private deployments or models not yet in the documented catalog. */
  modelLimits?: (params: AIProviderStreamParams) => Promise<AIModelLimits>;
}): NonNullable<AIProviderConfig["inputCapacity"]> => ({
  outputTokens: (params) => {
    const value = config.body(params).max_output_tokens;
    return value === undefined ? undefined : positiveTokenLimit(value);
  },
  getLimits: async (params) => {
    if (config.modelLimits) return config.modelLimits(params);
    if (new URL(config.baseUrl).origin !== "https://api.openai.com")
      throw new AIInputError(
        "capacity_unavailable",
        "This compatible endpoint must expose its own model capacity.",
      );
    const limits = LIMITS[params.model];
    if (!limits)
      throw new AIInputError(
        "capacity_unavailable",
        `Model limits are unavailable for ${params.model}; no character limit has been substituted.`,
      );
    return { ...limits };
  },
  countTokens: async (params) => {
    const headers = new Headers(await config.headers(params));
    headers.set("Authorization", `Bearer ${await config.key()}`);
    headers.set("Content-Type", "application/json");
    const body = config.body(params);
    const counted: Record<string, unknown> = {};
    for (const key of [
      "model",
      "input",
      "instructions",
      "tools",
      "tool_choice",
      "reasoning",
      "text",
      "parallel_tool_calls",
    ])
      if (body[key] !== undefined) counted[key] = body[key];
    const response = await config.fetch(
      `${config.baseUrl}/v1/responses/input_tokens`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(counted),
        signal: params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
    return inputTokenCount((await capacityJson(response)).input_tokens);
  },
});
