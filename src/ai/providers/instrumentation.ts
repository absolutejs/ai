import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
  AIUsage,
} from "../../../types/ai";
import { withResilience } from "../resilience";

// Every provider factory routes through here, so this is also where the
// automatic retry + circuit-breaker layer is applied — wrapping the raw provider
// BENEATH the usage/span tap so onUsage/onSpan fire once, for the attempt that
// actually streamed.
export const instrumentAIProvider = (
  provider: AIProviderConfig,
  providerName?: string,
): AIProviderConfig => {
  const resilient = withResilience(provider, providerName);

  return {
    stream: (params: AIProviderStreamParams) => {
      if (!params.onUsage && !params.onSpan) {
        return resilient.stream(params);
      }
      return tapStream(resilient.stream(params), params, providerName);
    },
  };
};

async function* tapStream(
  source: AsyncIterable<AIChunk>,
  params: AIProviderStreamParams,
  providerName?: string,
): AsyncIterable<AIChunk> {
  const startedAt = Date.now();
  let lastUsage: AIUsage | undefined;
  try {
    for await (const chunk of source) {
      if (chunk.type === "done" && chunk.usage) {
        lastUsage = chunk.usage;
      }
      yield chunk;
    }
  } finally {
    if (lastUsage && params.onUsage) {
      try {
        params.onUsage({
          ...lastUsage,
          model: params.model,
          provider: providerName,
        });
      } catch {
        // operator-supplied callback errors must not affect stream consumers
      }
    }
    if (params.onSpan) {
      try {
        params.onSpan({
          durationMs: Date.now() - startedAt,
          model: params.model,
          provider: providerName,
          usage: lastUsage,
        });
      } catch {
        // same
      }
    }
  }
}
