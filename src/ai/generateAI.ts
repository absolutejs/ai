import type {
  AIProviderConfig,
  AIProviderMessage,
  AIProviderResponseFormat,
  AIProviderToolChoice,
  AIProviderToolDefinition,
  AIUsage,
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
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: AIProviderToolDefinition[];
  toolChoice?: AIProviderToolChoice;
  responseFormat?: AIProviderResponseFormat;
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

export type GenerateObjectAIOptions<T> = {
  provider: AIProviderConfig;
  model: string;
  messages: AIProviderMessage[];
  schema: Record<string, unknown>;
  systemPrompt?: string;
  /** Cache the system prompt (Anthropic prompt caching). See AIProviderStreamParams. */
  cacheSystemPrompt?: boolean;
  toolName?: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
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
    provider: options.provider,
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
