import type { AIChunk } from "../../types/ai";
import { ProviderError } from "./errors/providerError";

/** Execute approved, individually metered alternatives. Never replay a stream
 * after any chunk (including tools or usage), or after caller cancellation. */
export async function* streamWithProviderFallback(options: {
  models: readonly string[];
  stream: (model: string) => AsyncIterable<AIChunk>;
  signal?: AbortSignal;
  onFallback?: (event: {
    from: string;
    to: string;
    error: ProviderError;
  }) => void | Promise<void>;
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
      if (
        emitted ||
        !next ||
        !(error instanceof ProviderError) ||
        !(error.billingUnavailable || error.retryable || error.notSent)
      )
        throw error;
      await options.onFallback?.({ from: model, to: next, error });
    }
  }
}
