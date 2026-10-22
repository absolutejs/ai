import type { AIChunk } from "../../types/ai";
import { isProviderError } from "./errors/providerError";

export type AIProviderFallback = {
  models: readonly string[] | ((model: string) => readonly string[]);
  onFallback?: (event: {
    from: string;
    to: string;
    error: Error;
  }) => void | Promise<void>;
};
export const providerFallbackModels = (
  model: string,
  recovery?: AIProviderFallback,
): string[] => [
  ...new Set([
    model,
    ...(recovery
      ? typeof recovery.models === "function"
        ? recovery.models(model)
        : recovery.models
      : []),
  ]),
];

/** Provider-specific failures may use an approved alternative. Application,
 * cancellation and accounting errors must never be hidden by fallback. */
export const isAIProviderFailure = (error: unknown): error is Error => {
  if (isProviderError(error))
    return (
      error.billingUnavailable ||
      error.retryable ||
      error.notSent ||
      (error.status !== null &&
        [400, 401, 403, 404, 413, 422].includes(error.status))
    );
  return (
    error instanceof Error &&
    error.name === "AIInputError" &&
    "code" in error &&
    error.code === "capacity_unavailable" &&
    "providerStatus" in error &&
    typeof error.providerStatus === "number" &&
    error.providerStatus >= 400
  );
};
export const isPermanentAIProviderFailure = (error: unknown): boolean => {
  if (isProviderError(error)) return !error.retryable;
  if (
    error instanceof Error &&
    "providerError" in error &&
    isProviderError(error.providerError)
  )
    return !error.providerError.retryable;
  return (
    isAIProviderFailure(error) &&
    "providerStatus" in error &&
    typeof error.providerStatus === "number" &&
    error.providerStatus < 500 &&
    ![408, 409, 425, 429].includes(error.providerStatus)
  );
};

/** Only for side-effect-free checks. Each selected provider performs its own
 * tokenizer/limits validation; no cross-provider token estimate is reused. */
export const inspectWithProviderFallback = async <T>(options: {
  model: string;
  recovery?: AIProviderFallback;
  signal?: AbortSignal;
  inspect: (model: string) => Promise<T>;
}): Promise<{ model: string; value: T }> => {
  const models = providerFallbackModels(options.model, options.recovery);
  for (const [index, model] of models.entries()) {
    options.signal?.throwIfAborted();
    try {
      return { model, value: await options.inspect(model) };
    } catch (error) {
      options.signal?.throwIfAborted();
      const next = models[index + 1];
      if (!next || !isAIProviderFailure(error)) throw error;
      await options.recovery?.onFallback?.({ from: model, to: next, error });
    }
  }
  throw new Error("No approved model available");
};

/** Never replay a stream after any chunk (including tools or usage), or after
 * caller cancellation. Each candidate owns its own preflight and metering. */
export async function* streamWithProviderFallback(options: {
  models: readonly string[];
  stream: (model: string) => AsyncIterable<AIChunk>;
  signal?: AbortSignal;
  onFallback?: AIProviderFallback["onFallback"];
}): AsyncIterable<AIChunk> {
  const models = [...new Set(options.models)];
  if (!models.length)
    throw new Error("At least one approved model is required");
  for (const [index, model] of models.entries()) {
    options.signal?.throwIfAborted();
    let emitted = false;
    try {
      for await (const chunk of options.stream(model)) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      options.signal?.throwIfAborted();
      const next = models[index + 1];
      if (emitted || !next || !isAIProviderFailure(error)) throw error;
      await options.onFallback?.({ from: model, to: next, error });
    }
  }
}
