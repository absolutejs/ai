import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
  AIUsage,
} from "../../../types/ai";

export const instrumentAIProvider = (
  provider: AIProviderConfig,
  providerName?: string,
): AIProviderConfig => ({
  stream: (params: AIProviderStreamParams) => {
    if (!params.onUsage && !params.onSpan) {
      return provider.stream(params);
    }
    return tapStream(provider.stream(params), params, providerName);
  },
});

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
