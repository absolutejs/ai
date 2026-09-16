import type { AIProviderConfig, AIProviderStreamParams } from "../../types/ai";

/** Provider-reported limits. Some providers have separate input/output windows. */
export type AIModelLimits = {
  maxInputTokens: number;
  maxOutputTokens: number;
  contextWindowTokens?: number;
};
export type AIInputCapacity = {
  limits: AIModelLimits;
  inputTokens: number;
  outputTokens: number;
  availableInputTokens: number;
  fits: boolean;
};
export class AIInputError extends Error {
  constructor(
    public readonly code:
      | "capacity_unavailable"
      | "input_too_large"
      | "unsupported_content",
    message: string,
  ) {
    super(message);
    this.name = "AIInputError";
  }
}
export const positiveTokenLimit = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new AIInputError(
      "capacity_unavailable",
      "The provider did not supply a valid model limit.",
    );
  return value;
};
export const inputTokenCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AIInputError(
      "capacity_unavailable",
      "The provider did not supply a valid token count.",
    );
  return value;
};

/** No character/token conversion guesses. Includes the serialized prompt and tools. */
export const inspectAIInput = async (
  provider: AIProviderConfig,
  params: AIProviderStreamParams,
): Promise<AIInputCapacity> => {
  params.signal?.throwIfAborted();
  if (!provider.inputCapacity)
    throw new AIInputError(
      "capacity_unavailable",
      "This provider does not expose model capacity and token counting.",
    );
  const [limits, tokens] = await Promise.all([
    provider.inputCapacity.getLimits(params),
    provider.inputCapacity.countTokens(params),
  ]).catch((error: unknown) => {
    // Provider subpaths may bundle their own AIInputError constructor. Preserve
    // the high-level error contract instead of leaking a different class copy.
    if (
      error instanceof Error &&
      error.name === "AIInputError" &&
      "code" in error &&
      (error.code === "capacity_unavailable" ||
        error.code === "input_too_large" ||
        error.code === "unsupported_content")
    )
      throw new AIInputError(error.code, error.message);
    throw error;
  });
  const inputTokens = inputTokenCount(tokens);
  const outputTokens = positiveTokenLimit(
    provider.inputCapacity.outputTokens?.(params) ??
      params.maxTokens ??
      limits.maxOutputTokens,
  );
  const maxInputTokens = positiveTokenLimit(limits.maxInputTokens);
  const maxOutputTokens = positiveTokenLimit(limits.maxOutputTokens);
  const availableInputTokens = Math.max(
    0,
    Math.min(
      maxInputTokens,
      limits.contextWindowTokens === undefined
        ? maxInputTokens
        : positiveTokenLimit(limits.contextWindowTokens) - outputTokens,
    ),
  );
  return {
    limits,
    inputTokens,
    outputTokens,
    availableInputTokens,
    fits:
      outputTokens <= maxOutputTokens && inputTokens <= availableInputTokens,
  };
};

/** Cache metadata per provider instance; use a zero TTL with rotating auth/headers. never cache failures. */
export const cacheModelLimits = (
  load: (params: AIProviderStreamParams) => Promise<AIModelLimits>,
  ttlMs = 300_000,
) => {
  const cache = new Map<string, { at: number; limits: AIModelLimits }>();
  return async (params: AIProviderStreamParams) => {
    const entry = cache.get(params.model);
    if (entry && Date.now() - entry.at < ttlMs) return entry.limits;
    const limits = await load(params);
    positiveTokenLimit(limits.maxInputTokens);
    positiveTokenLimit(limits.maxOutputTokens);
    if (cache.size >= 100) cache.clear();
    cache.set(params.model, { at: Date.now(), limits });
    return limits;
  };
};

export const capacityJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  if (!response.ok)
    throw new AIInputError(
      "capacity_unavailable",
      `Model capacity request failed (${response.status}).`,
    );
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AIInputError(
      "capacity_unavailable",
      "Model capacity response was invalid.",
    );
  return value as Record<string, unknown>;
};
