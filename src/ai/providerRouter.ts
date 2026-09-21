import type { AIProviderConfig, AIProviderStreamParams } from "../../types/ai";
import { AIInputError } from "./inputCapacity";

/** Route exact model IDs to providers. Counting, limits and generation use the
 * same route, including when preparation uses a different model/provider. */
export const createAIProviderRouter = (
  routes: Readonly<Record<string, AIProviderConfig>>,
): AIProviderConfig => {
  const providers = new Map(Object.entries(routes));
  const resolve = (params: AIProviderStreamParams) => {
    params.signal?.throwIfAborted();
    const provider = providers.get(params.model);
    if (!provider)
      throw new AIInputError(
        "capacity_unavailable",
        `No provider route for model ${params.model}.`,
      );
    return provider;
  };
  const capacity = (params: AIProviderStreamParams) => {
    const result = resolve(params).inputCapacity;
    if (!result)
      throw new AIInputError(
        "capacity_unavailable",
        `The provider for ${params.model} does not expose model capacity and token counting.`,
      );
    return result;
  };
  return {
    inputCapacity: {
      outputTokens: (params) => capacity(params).outputTokens?.(params),
      isContextError: (error) =>
        [...new Set(providers.values())].some(
          (provider) =>
            provider.inputCapacity?.isContextError?.(error) === true,
        ),
      getLimits: async (params) => capacity(params).getLimits(params),
      countScope: (params) =>
        capacity(params).countScope?.(params) ?? "request",
      countTokens: async (params) => capacity(params).countTokens(params),
    },
    stream: (params) => resolve(params).stream(params),
  };
};
