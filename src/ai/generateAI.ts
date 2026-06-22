import type {
  AIProviderConfig,
  AIProviderContentBlock,
  AIProviderMessage,
  AIProviderResponseFormat,
  AIProviderToolChoice,
  AIProviderToolDefinition,
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
  provider: AIProviderConfig;
  model: string;
  messages: AIProviderMessage[];
  systemPrompt?: string;
  /** Cache the system prompt (Anthropic prompt caching). See AIProviderStreamParams. */
  cacheSystemPrompt?: boolean;
  /** Per-call override of the provider `promptCaching` default. See AIProviderStreamParams. */
  promptCaching?: boolean;
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
  const stream = options.provider.stream({
    cacheSystemPrompt: options.cacheSystemPrompt,
    maxTokens: options.maxTokens,
    messages: options.messages,
    model: options.model,
    promptCaching: options.promptCaching,
    reasoning: options.reasoning,
    responseFormat: options.responseFormat,
    signal: options.signal,
    stopSequences: options.stopSequences,
    systemPrompt: options.systemPrompt,
    temperature: options.temperature,
    toolChoice: options.toolChoice,
    tools: options.tools,
    topP: options.topP,
  });

  let text = "";
  const toolCalls: GenerateAIToolCall[] = [];
  let usage: AIUsage | undefined;

  for await (const chunk of stream) {
    if (chunk.type === "text") {
      text += chunk.content;
    } else if (chunk.type === "tool_use") {
      toolCalls.push({ id: chunk.id, input: chunk.input, name: chunk.name });
    } else if (chunk.type === "done") {
      usage = chunk.usage;
    }
  }

  return { text, toolCalls, usage };
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
  usage?: AIUsage;
  /** The full message thread incl. assistant tool_use + tool_result turns. */
  messages: AIProviderMessage[];
};

const mergeUsage = (left: AIUsage | undefined, right: AIUsage | undefined) => {
  if (!left) return right;
  if (!right) return left;
  const add = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

  return {
    cacheReadInputTokens: add(
      left.cacheReadInputTokens,
      right.cacheReadInputTokens,
    ),
    cacheWriteInputTokens: add(
      left.cacheWriteInputTokens,
      right.cacheWriteInputTokens,
    ),
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
  };
};

const toProviderTools = (tools: AIToolMap): AIProviderToolDefinition[] =>
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

  const runTurn = async (
    messages: AIProviderMessage[],
    turnsLeft: number,
  ): Promise<GenerateAIWithToolsResult> => {
    const result = await generateAI({
      ...base,
      messages,
      toolChoice: "auto",
      tools: providerTools,
    });
    usage = mergeUsage(usage, result.usage);
    if (result.toolCalls.length === 0 || turnsLeft <= 1) {
      return { messages, text: result.text, toolCalls, usage };
    }
    toolCalls.push(...result.toolCalls);

    const assistantBlocks: AIProviderContentBlock[] = [
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

    return runTurn(
      [
        ...messages,
        { content: assistantBlocks, role: "assistant" },
        { content: resultBlocks, role: "user" },
      ],
      turnsLeft - 1,
    );
  };

  return runTurn(options.messages, maxTurns);
};

export type GenerateObjectAIOptions<T> = {
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
  signal?: AbortSignal;
};

export type GenerateObjectAIResult<T> = {
  object: T;
  usage?: AIUsage;
};

/**
 * One-shot structured output, provider-agnostic. Exposes the caller's JSON
 * schema as a single synthetic tool and forces the model to call it, then
 * returns the parsed tool input as the result object. Pass `validate` (e.g. a
 * Zod `schema.parse`) to narrow `unknown` to `T` and reject malformed output.
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

  const { toolCalls, usage } = await generateAI({
    cacheSystemPrompt: options.cacheSystemPrompt,
    maxTokens: options.maxTokens,
    messages: options.messages,
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

  const call = toolCalls.find((toolCall) => toolCall.name === toolName);
  if (!call) {
    throw new Error(
      `generateObjectAI: model did not call the "${toolName}" tool`,
    );
  }

  const object = options.validate
    ? options.validate(call.input)
    : (call.input as T);

  return { object, usage };
};
