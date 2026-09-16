import type {
  AIChunk,
  AIProviderConfig,
  AIProviderMessage,
  AIProviderStreamParams,
} from "../../types/ai";
import {
  AIInputError,
  inspectAIInput,
  inputTokenCount,
  positiveTokenLimit,
  type AIInputCapacity,
} from "./inputCapacity";

/** Token budgets, never character approximations or guessed model limits. */
export type AIContextBudget = {
  /** Optional working target below the model's hard input capacity. */
  workingInputTokens?: number;
  /** Default: 1% of available input, capped at 2,048 tokens. */
  countingMarginTokens?: number;
  /** Default with tools: 10% of available input, capped at 8,192 tokens. */
  toolResultReserveTokens?: number;
};
export type AIContextCapacity = AIInputCapacity & {
  workingInputTokens: number;
  countingMarginTokens: number;
  toolResultReserveTokens: number;
  withinWorkingLimit: boolean;
};
export type AIContextRecoveryReason = "working_limit" | "provider_rejection";
export type AIContextEvent =
  | { type: "checked"; capacity: AIContextCapacity }
  | {
      type: "recovered";
      reason: AIContextRecoveryReason;
      before: AIContextCapacity;
      after: AIContextCapacity;
    };
export type AIContextPolicy = AIContextBudget & {
  /** Called at most once per model turn, before any output. Preserve originals
   * in application storage; return compacted/retrieved messages, never effects.
   * Tool IDs/inputs, signed thinking, media, provider data and system messages
   * must remain intact. Tool result text may be replaced with saved-source notes. */
  recover?: (input: {
    params: AIProviderStreamParams;
    capacity: AIContextCapacity;
    reason: AIContextRecoveryReason;
  }) => Promise<AIProviderMessage[]>;
  onEvent?: (event: AIContextEvent) => void;
};

export const inspectAIContext = async (
  provider: AIProviderConfig,
  params: AIProviderStreamParams,
  budget: AIContextBudget = {},
): Promise<AIContextCapacity> => {
  const capacity = await inspectAIInput(provider, params);
  const countingMarginTokens = inputTokenCount(
    budget.countingMarginTokens ??
      Math.min(2048, Math.ceil(capacity.availableInputTokens / 100)),
  );
  const toolResultReserveTokens = inputTokenCount(
    budget.toolResultReserveTokens ??
      (params.tools?.length && params.toolChoice !== "none"
        ? Math.min(8192, Math.floor(capacity.availableInputTokens / 10))
        : 0),
  );
  const target =
    budget.workingInputTokens === undefined
      ? capacity.availableInputTokens
      : positiveTokenLimit(budget.workingInputTokens);
  const remaining = Math.min(
    target,
    capacity.availableInputTokens -
      countingMarginTokens -
      toolResultReserveTokens,
  );
  const workingInputTokens = Math.max(0, remaining);
  return {
    ...capacity,
    countingMarginTokens,
    toolResultReserveTokens,
    workingInputTokens,
    withinWorkingLimit:
      capacity.fits &&
      remaining >= 0 &&
      capacity.inputTokens <= workingInputTokens,
  };
};

/** Only an explicit structured capacity rejection qualifies; arbitrary 400s,
 * timeouts and provider outages do not. Provider adapters may add a classifier. */
export const isAIContextRejection = (error: unknown) => {
  // Provider entrypoints are independently bundled, so instanceof alone is
  // insufficient when an adapter and the high-level helpers use distinct copies.
  if (
    !(error instanceof Error) ||
    error.name !== "ProviderError" ||
    !("status" in error) ||
    !("type" in error) ||
    !("provider" in error) ||
    !("metadata" in error)
  )
    return false;
  if (
    typeof error.provider !== "string" ||
    (error.status !== null && typeof error.status !== "number") ||
    (error.type !== null && typeof error.type !== "string")
  )
    return false;
  const metadata =
    error.metadata &&
    typeof error.metadata === "object" &&
    !Array.isArray(error.metadata)
      ? error.metadata
      : undefined;
  const code = metadata && "code" in metadata ? metadata.code : error.type;
  if (
    (error.status === null || error.status === 400 || error.status === 413) &&
    code === "context_length_exceeded"
  )
    return true;
  // Narrow Anthropic format observed in its first-party issue tracker:
  // https://github.com/anthropics/claude-code/issues/62560
  return (
    error.provider === "anthropic" &&
    error.status === 400 &&
    metadata !== undefined &&
    "type" in metadata &&
    metadata.type === "invalid_request_error" &&
    "message" in metadata &&
    typeof metadata.message === "string" &&
    /^prompt is too long: \d+ tokens > \d+ maximum$/u.test(metadata.message)
  );
};

const protectedHistory = (messages: AIProviderMessage[]) =>
  JSON.stringify(
    messages.flatMap((message) => {
      if (message.role === "system") return [message];
      if (typeof message.content === "string") return [];
      const blocks = message.content
        .filter((block) => block.type !== "text")
        .map((block) =>
          block.type === "tool_result" ? { ...block, content: "" } : block,
        );
      return blocks.length ? [{ role: message.role, content: blocks }] : [];
    }),
  );
const snapshot = (params: AIProviderStreamParams): AIProviderStreamParams => ({
  ...params,
  messages: structuredClone(params.messages),
  tools: params.tools && structuredClone(params.tools),
  providerOptions:
    params.providerOptions && structuredClone(params.providerOptions),
  responseFormat:
    params.responseFormat && structuredClone(params.responseFormat),
  reasoning: params.reasoning && { ...params.reasoning },
});
const tooLarge = () =>
  new AIInputError(
    "input_too_large",
    "The request exceeds the model's working context budget. Preserve the original input and reduce or retrieve context before retrying.",
  );

/** Shared high-level dispatch. `false` deliberately opts into raw provider
 * behavior. Recovery never replays emitted output or executes application tools. */
export const streamWithAIContext = async function* (
  provider: AIProviderConfig,
  params: AIProviderStreamParams,
  policy: AIContextPolicy | false = {},
  onPrepared?: (params: AIProviderStreamParams) => void,
): AsyncGenerator<AIChunk> {
  params.signal?.throwIfAborted();
  if (policy === false) {
    onPrepared?.(params);
    yield* provider.stream(params);
    return;
  }
  let request = snapshot(params);
  let capacity = await inspectAIContext(provider, request, policy);
  policy.onEvent?.({
    type: "checked",
    capacity: { ...capacity, limits: { ...capacity.limits } },
  });
  let recovered = false;
  const recover = async (reason: AIContextRecoveryReason) => {
    if (
      recovered ||
      !policy.recover ||
      capacity.outputTokens > capacity.limits.maxOutputTokens
    )
      throw tooLarge();
    recovered = true;
    const protectedBefore = protectedHistory(request.messages);
    const messages = await policy.recover({
      params: snapshot(request),
      capacity: { ...capacity, limits: { ...capacity.limits } },
      reason,
    });
    request.signal?.throwIfAborted();
    if (
      !Array.isArray(messages) ||
      messages.some(
        (message) =>
          !message ||
          !["user", "assistant", "system"].includes(message.role) ||
          (typeof message.content !== "string" &&
            !Array.isArray(message.content)),
      ) ||
      protectedHistory(messages) !== protectedBefore
    )
      throw new AIInputError(
        "unsupported_content",
        "Context recovery must preserve tool exchanges, signed thinking, media, provider data and system messages.",
      );
    const nextRequest = { ...request, messages: structuredClone(messages) };
    const next = await inspectAIContext(provider, nextRequest, policy);
    if (!next.withinWorkingLimit || next.inputTokens >= capacity.inputTokens)
      throw tooLarge();
    policy.onEvent?.({
      type: "recovered",
      reason,
      before: { ...capacity, limits: { ...capacity.limits } },
      after: { ...next, limits: { ...next.limits } },
    });
    request = nextRequest;
    capacity = next;
  };
  if (!capacity.withinWorkingLimit) await recover("working_limit");
  let emitted = false;
  try {
    request.signal?.throwIfAborted();
    onPrepared?.(request);
    for await (const chunk of provider.stream(request)) {
      emitted = true;
      yield chunk;
    }
  } catch (error) {
    request.signal?.throwIfAborted();
    if (
      emitted ||
      recovered ||
      !policy.recover ||
      !(
        provider.inputCapacity?.isContextError?.(error) ??
        isAIContextRejection(error)
      )
    )
      throw error;
    await recover("provider_rejection");
    onPrepared?.(request);
    yield* provider.stream(request);
  }
};
