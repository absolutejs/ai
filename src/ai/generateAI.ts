import { streamWithAIContext, type AIContextPolicy } from "./contextPolicy";
import type {
  AICitationChunk,
  AIProviderConfig,
  AIProviderContentBlock,
  AIProviderMessage,
  AIProviderResponseFormat,
  AIProviderToolChoice,
  AIProviderToolDefinition,
  AIResponseMetadata,
  AIToolMap,
  AIUsage,
  ReasoningConfig,
} from "../../types/ai";

// Non-streaming convenience layer over the streaming provider interface.
// Backend transforms (cleanup, extraction, reformatting) need the finished
// result, not incremental tokens — so these helpers consume `provider.stream()`
// to completion and hand back the assembled value. Same request, same
// transport as streaming; they just spare every caller the collection loop.

const DEFAULT_OBJECT_TOOL_NAME = "respond";

export type GenerateAIToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type GenerateAIOptions = {
  contextPolicy?: AIContextPolicy | false;
  provider: AIProviderConfig;
  model: string;
  messages: AIProviderMessage[];
  systemPrompt?: string;
  /** Cache the system prompt (Anthropic prompt caching). See AIProviderStreamParams. */
  cacheSystemPrompt?: boolean;
  /** Per-call override of the provider `promptCaching` default. See AIProviderStreamParams. */
  promptCaching?: boolean;
  providerOptions?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: AIProviderToolDefinition[];
  toolChoice?: AIProviderToolChoice;
  responseFormat?: AIProviderResponseFormat;
  /** Portable reasoning effort — translated per provider/model. */
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
};

export type GenerateAIResult = {
  /** Exact assistant blocks retained for protocol-safe tool/repair turns. */
  contentBlocks?: AIProviderContentBlock[];
  /** Actual request history after any context recovery. */
  requestMessages?: AIProviderMessage[];
  citations: AICitationChunk[];
  metadata?: AIResponseMetadata;
  text: string;
  toolCalls: GenerateAIToolCall[];
  usage?: AIUsage;
};

/**
 * One-shot, non-streaming generation. Drains the provider stream and returns
 * the full assembled text, any tool calls the model made (with input already
 * JSON-parsed by the provider), and final token usage.
 */
export const generateAI = async (
  options: GenerateAIOptions,
): Promise<GenerateAIResult> => {
  let requestMessages = options.messages;
  const stream = streamWithAIContext(
    options.provider,
    {
      cacheSystemPrompt: options.cacheSystemPrompt,
      maxTokens: options.maxTokens,
      messages: options.messages,
      model: options.model,
      promptCaching: options.promptCaching,
      providerOptions: options.providerOptions,
      reasoning: options.reasoning,
      responseFormat: options.responseFormat,
      signal: options.signal,
      stopSequences: options.stopSequences,
      systemPrompt: options.systemPrompt,
      temperature: options.temperature,
      toolChoice: options.toolChoice,
      tools: options.tools,
      topP: options.topP,
    },
    options.contextPolicy,
    (request) => {
      requestMessages = request.messages;
    },
  );

  const contentBlocks: AIProviderContentBlock[] = [];
  let thinking: { text: string; signature?: string } | undefined;
  const flushThinking = () => {
    if (thinking)
      contentBlocks.push({
        type: "thinking",
        thinking: thinking.text,
        signature: thinking.signature,
      });
    thinking = undefined;
  };
  let text = "";
  const toolCalls: GenerateAIToolCall[] = [];
  const citations: AICitationChunk[] = [];
  let usage: AIUsage | undefined;
  let metadata: AIResponseMetadata | undefined;

  for await (const chunk of stream) {
    if (chunk.type === "thinking") {
      thinking ??= { text: "" };
      thinking.text += chunk.content;
      if (chunk.signature) thinking.signature = chunk.signature;
    } else if (chunk.type === "text") {
      flushThinking();
      const last = contentBlocks.at(-1);
      if (last?.type === "text") last.content += chunk.content;
      else contentBlocks.push({ type: "text", content: chunk.content });
      text += chunk.content;
    } else if (chunk.type === "tool_use") {
      flushThinking();
      contentBlocks.push({
        type: "tool_use",
        id: chunk.id,
        name: chunk.name,
        input:
          chunk.input && typeof chunk.input === "object" ? chunk.input : {},
        providerData: chunk.providerData,
      });
      toolCalls.push({ id: chunk.id, input: chunk.input, name: chunk.name });
    } else if (chunk.type === "provider_event") {
      flushThinking();
      contentBlocks.push({
        type: "provider_data",
        provider: chunk.provider,
        data: chunk.data,
      });
    } else if (chunk.type === "citation") {
      citations.push(chunk);
    } else if (chunk.type === "done") {
      usage = chunk.usage;
      metadata = chunk.metadata;
    }
  }

  flushThinking();
  return {
    citations,
    contentBlocks,
    requestMessages,
    metadata,
    text,
    toolCalls,
    usage,
  };
};

const DEFAULT_TOOL_MAX_TURNS = 6;

export type GenerateAIWithToolsOptions = Omit<
  GenerateAIOptions,
  "tools" | "toolChoice"
> & {
  /** Tools the model may call — each with a `handler` the loop runs on its behalf. */
  tools: AIToolMap;
  /** Max model⇄tool round-trips before forcing a final answer. Default 6. */
  maxTurns?: number;
  /** Observe each executed tool call (name, parsed input, string result). */
  onToolUse?: (name: string, input: unknown, result: string) => void;
};

export type GenerateAIWithToolsResult = {
  text: string;
  toolCalls: GenerateAIToolCall[];
  /** Model turns consumed, including a forced final synthesis when needed. */
  turns: number;
  /** Whether the model completed normally or required max-turn finalization. */
  stopReason: "completed" | "max_turns_finalized";
  usage?: AIUsage;
  /** The full message thread incl. assistant tool_use + tool_result turns. */
  messages: AIProviderMessage[];
};

export const mergeUsage = (
  left: AIUsage | undefined,
  right: AIUsage | undefined,
) => {
  if (!left) return right;
  if (!right) return left;
  const add = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const serverToolUse = { ...left.serverToolUse };
  for (const [key, value] of Object.entries(right.serverToolUse ?? {}))
    serverToolUse[key] = (serverToolUse[key] ?? 0) + value;

  return {
    cacheReadInputTokens: add(
      left.cacheReadInputTokens,
      right.cacheReadInputTokens,
    ),
    cacheWriteInputTokens: add(
      left.cacheWriteInputTokens,
      right.cacheWriteInputTokens,
    ),
    costCredits: add(left.costCredits, right.costCredits),
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
    serverToolUse:
      Object.keys(serverToolUse).length > 0 ? serverToolUse : undefined,
    upstreamInferenceCostCredits: add(
      left.upstreamInferenceCostCredits,
      right.upstreamInferenceCostCredits,
    ),
  };
};

export const toProviderTools = (tools: AIToolMap): AIProviderToolDefinition[] =>
  Object.entries(tools).map(([name, definition]) => ({
    description: definition.description,
    input_schema: definition.input,
    name,
  }));

/**
 * Agentic, non-streaming generation: the model may call the provided handler tools, this
 * runs them, feeds the results back, and loops until the model answers (or `maxTurns`).
 * Transport-agnostic — usable from HTTP/SSE/generator paths, unlike the WebSocket `streamAI`.
 * Returns the final text, every tool call made, summed usage, and the full message thread.
 */
export const generateAIWithTools = async (
  options: GenerateAIWithToolsOptions,
): Promise<GenerateAIWithToolsResult> => {
  const {
    maxTurns = DEFAULT_TOOL_MAX_TURNS,
    onToolUse,
    tools,
    ...base
  } = options;
  const providerTools = toProviderTools(tools);
  const toolCalls: GenerateAIToolCall[] = [];
  let usage: AIUsage | undefined;
  let turns = 0;

  const executeCalls = async (
    messages: AIProviderMessage[],
    result: GenerateAIResult,
  ) => {
    toolCalls.push(...result.toolCalls);
    const assistantBlocks: AIProviderContentBlock[] = result.contentBlocks ?? [
      ...(result.text ? [{ content: result.text, type: "text" as const }] : []),
      ...result.toolCalls.map((call) => ({
        id: call.id,
        // Providers (Anthropic) require tool_use.input to be an object on the way back;
        // a no-arg tool can parse to null/undefined, so coerce to {}.
        input: call.input && typeof call.input === "object" ? call.input : {},
        name: call.name,
        type: "tool_use" as const,
      })),
    ];
    const resultBlocks = await Promise.all(
      result.toolCalls.map(async (call) => {
        const definition = tools[call.name];
        const output = definition
          ? await Promise.resolve(definition.handler(call.input)).catch(
              (err: unknown) =>
                `Error: ${err instanceof Error ? err.message : String(err)}`,
            )
          : `Error: unknown tool "${call.name}"`;
        onToolUse?.(call.name, call.input, output);

        return {
          content: output,
          tool_use_id: call.id,
          type: "tool_result" as const,
        };
      }),
    );

    return [
      ...(result.requestMessages ?? messages),
      { content: assistantBlocks, role: "assistant" as const },
      { content: resultBlocks, role: "user" as const },
    ];
  };

  const runTurn = async (
    messages: AIProviderMessage[],
    turnsLeft: number,
  ): Promise<GenerateAIWithToolsResult> => {
    turns += 1;
    const result = await generateAI({
      ...base,
      messages,
      toolChoice: "auto",
      tools: providerTools,
    });
    usage = mergeUsage(usage, result.usage);
    if (result.toolCalls.length === 0) {
      return {
        messages: result.requestMessages ?? messages,
        stopReason: "completed",
        text: result.text,
        toolCalls,
        turns,
        usage,
      };
    }
    const nextMessages = await executeCalls(messages, result);
    if (turnsLeft <= 1) {
      turns += 1;
      const final = await generateAI({
        ...base,
        messages: nextMessages,
        toolChoice: "none",
        tools: providerTools,
      });
      usage = mergeUsage(usage, final.usage);

      return {
        messages: final.requestMessages ?? nextMessages,
        stopReason: "max_turns_finalized",
        text: final.text,
        toolCalls,
        turns,
        usage,
      };
    }

    return runTurn(nextMessages, turnsLeft - 1);
  };

  return runTurn(options.messages, Math.max(1, maxTurns));
};

export type GenerateObjectAIOptions<T> = {
  contextPolicy?: AIContextPolicy | false;
  provider: AIProviderConfig;
  model: string;
  messages: AIProviderMessage[];
  schema: Record<string, unknown>;
  systemPrompt?: string;
  /** Cache the system prompt (Anthropic prompt caching). See AIProviderStreamParams. */
  cacheSystemPrompt?: boolean;
  /** Per-call override of the provider `promptCaching` default. See AIProviderStreamParams. */
  promptCaching?: boolean;
  toolName?: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
  /** Portable reasoning effort — translated per provider/model. */
  reasoning?: ReasoningConfig;
  validate?: (raw: unknown) => T;
  /**
   * When the model fails to produce usable structured output — it skips the tool
   * call, or `validate` throws — re-prompt it with the specific failure and ask
   * it to correct itself, up to this many EXTRA attempts. Default 1.
   *
   * Models routinely overrun a `maxLength`, pick an off-enum value, or drop a
   * field; those are recoverable deviations, not fatal errors. One repair pass
   * turns the common failure from "the whole feature throws" into "the model
   * fixes its own output". Set to 0 to restore strict single-attempt behaviour.
   */
  maxRepairAttempts?: number;
  signal?: AbortSignal;
};

export type GenerateObjectAIResult<T> = {
  object: T;
  usage?: AIUsage;
};

const DEFAULT_OBJECT_REPAIR_ATTEMPTS = 1;

/**
 * One-shot structured output, provider-agnostic. Exposes the caller's JSON
 * schema as a single synthetic tool and forces the model to call it, then
 * returns the parsed tool input as the result object. Pass `validate` (e.g. a
 * Zod `schema.parse`) to narrow `unknown` to `T` and reject malformed output.
 *
 * Malformed output is not treated as fatal: when the model skips the tool call
 * or `validate` throws, the call is retried with the specific failure fed back
 * to the model (`maxRepairAttempts`, default 1) so it can correct itself before
 * the error finally surfaces.
 *
 * Works for any provider that supports forced tool choice — it does not rely
 * on a provider-specific structured-output API.
 */
export const generateObjectAI = async <T = unknown>(
  options: GenerateObjectAIOptions<T>,
): Promise<GenerateObjectAIResult<T>> => {
  const toolName = options.toolName ?? DEFAULT_OBJECT_TOOL_NAME;

  const tool: AIProviderToolDefinition = {
    description:
      options.toolDescription ??
      "Return the final structured result. Call this exactly once.",
    input_schema: options.schema,
    name: toolName,
  };

  const maxRepairAttempts = Math.max(
    0,
    options.maxRepairAttempts ?? DEFAULT_OBJECT_REPAIR_ATTEMPTS,
  );
  // Grows by an assistant tool_use + user tool_result pair after each failed
  // attempt, so the model sees exactly what it got wrong on the retry.
  const messages: AIProviderMessage[] = [...options.messages];
  let usage: AIUsage | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    const result = await generateAI({
      contextPolicy: options.contextPolicy,
      cacheSystemPrompt: options.cacheSystemPrompt,
      maxTokens: options.maxTokens,
      messages,
      model: options.model,
      promptCaching: options.promptCaching,
      provider: options.provider,
      reasoning: options.reasoning,
      signal: options.signal,
      systemPrompt: options.systemPrompt,
      temperature: options.temperature,
      toolChoice: { name: toolName },
      tools: [tool],
    });
    usage = mergeUsage(usage, result.usage);
    if (result.requestMessages)
      messages.splice(0, messages.length, ...result.requestMessages);

    const call = result.toolCalls.find(
      (toolCall) => toolCall.name === toolName,
    );

    let failure: string | undefined;
    let object: T | undefined;
    if (!call) {
      lastError = new Error(
        `generateObjectAI: model did not call the "${toolName}" tool`,
      );
      failure = `You did not call the "${toolName}" tool. Call it exactly once with the structured result.`;
    } else {
      try {
        object = options.validate
          ? options.validate(call.input)
          : (call.input as T);
      } catch (error) {
        lastError = error;
        failure = `Your "${toolName}" output failed validation: ${
          error instanceof Error ? error.message : String(error)
        }. Call "${toolName}" again with corrected output that satisfies the schema.`;
      }
    }

    if (failure === undefined) return { object: object as T, usage };
    if (attempt >= maxRepairAttempts) break;

    // Retain the exact assistant protocol blocks, even if it called the wrong
    // tool or omitted the structured-output tool entirely.
    if (result.contentBlocks?.length)
      messages.push({ role: "assistant", content: result.contentBlocks });
    if (result.toolCalls.length) {
      messages.push({
        role: "user",
        content: result.toolCalls.map((pending) => ({
          content:
            pending.id === call?.id
              ? failure
              : `Only call the "${toolName}" tool with the requested structured result.`,
          tool_use_id: pending.id,
          type: "tool_result" as const,
        })),
      });
    } else messages.push({ content: failure, role: "user" });
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`generateObjectAI: failed to produce valid output`);
};
