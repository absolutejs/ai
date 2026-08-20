import type {
  AIChunk,
  AIProviderConfig,
  AIProviderContentBlock,
  AIProviderMessage,
  AIProviderStreamParams,
  AIProviderToolDefinition,
  AIUsage,
} from "../../../types/ai";
import type {
  AnthropicConfig,
  AnthropicMessage,
  AnthropicSSEState,
} from "../../../types/anthropic";

// Opportunistic HTTP/2 multiplexing for outbound HTTPS (Bun 1.3.14+).
// The `protocol` option lands in @types/bun 1.3.14; widen locally for now.
// Hard-skip on non-HTTPS — Bun's h2 client throws HTTP2Unsupported on h2c.
type H2Init = RequestInit & { protocol?: "http2" };
const h2IfHttps = (url: string): H2Init =>
  url.startsWith("https://") ? { protocol: "http2" } : {};

import { instrumentAIProvider } from "./instrumentation";
import { ProviderError } from "../errors/providerError";
import {
  anthropicEffortValue,
  anthropicReasoningMode,
  anthropicSupportsSampling,
  resolveBudgetTokens,
} from "./reasoning";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 32000;
const EVENT_PREFIX_LENGTH = 7;
const DATA_PREFIX_LENGTH = 6;

const EMPTY_CHUNKS: AIChunk[] = [];

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

const mapContentBlock = (block: AIProviderContentBlock) => {
  if (block.type === "thinking") {
    return {
      signature: block.signature,
      thinking: block.thinking,
      type: "thinking",
    };
  }

  if (block.type === "image") {
    return {
      source: block.source,
      type: "image",
    };
  }

  if (block.type === "document") {
    return {
      source: block.source,
      type: "document",
    };
  }

  if (block.type === "tool_result") {
    return {
      content: block.content,
      tool_use_id: block.tool_use_id,
      type: "tool_result",
    };
  }

  if (block.type === "tool_use") {
    if (block.providerData) return { ...block.providerData };
    return {
      id: block.id,
      input: block.input,
      name: block.name,
      type: "tool_use",
    };
  }

  if (block.type === "audio" || block.type === "video") {
    throw new Error(`Anthropic does not support ${block.type} content blocks`);
  }

  if (block.type === "provider_data") {
    return { ...block.data };
  }

  return { text: block.content, type: "text" };
};

const mapMessage = (msg: AIProviderMessage): AnthropicMessage => ({
  content:
    typeof msg.content === "string"
      ? msg.content
      : msg.content.map(mapContentBlock),
  role: msg.role === "system" ? "user" : msg.role,
});

const mapToolDefinition = (tool: AIProviderToolDefinition) => ({
  description: tool.description,
  input_schema: tool.input_schema,
  name: tool.name,
});

// Attach an ephemeral cache breakpoint to the final content block of a message.
// `content` may be a bare string (collapse to a single cached text block) or an
// array of blocks (clone the last block and tag it). Returns a new message; the
// input is left untouched.
const cacheLastContentBlock = (msg: AnthropicMessage): AnthropicMessage => {
  const cacheControl = { type: "ephemeral" };

  if (typeof msg.content === "string") {
    return {
      content: [
        { cache_control: cacheControl, text: msg.content, type: "text" },
      ],
      role: msg.role,
    };
  }

  if (msg.content.length === 0) return msg;

  const blocks = [...msg.content];
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: cacheControl,
  };

  return { content: blocks, role: msg.role };
};

const buildRequestBody = (
  params: AIProviderStreamParams,
  configuredMax: number,
  configCaching: boolean,
) => {
  // Per-call override wins over the provider default, so a caller can opt a
  // known one-shot out of the 1.25x cache-write (or force caching on).
  const caching = params.promptCaching ?? configCaching;
  // The system block specifically can be overridden by the legacy
  // `cacheSystemPrompt` (tri-state: true/false force it; undefined follows the
  // effective `caching`).
  const cacheSystem = params.cacheSystemPrompt ?? caching;

  const messages: AnthropicMessage[] = params.messages
    .filter((msg) => msg.role !== "system")
    .map(mapMessage);

  // Rolling prefix breakpoint: when there is prior history, mark the final
  // content block of the last message so the next turn reads this turn's
  // prefix from cache. Skipped on the first turn (nothing to reuse yet).
  if (caching && messages.length > 1) {
    const last = messages[messages.length - 1];
    if (last) {
      messages[messages.length - 1] = cacheLastContentBlock(last);
    }
  }

  // Per-call `params.maxTokens` wins over the per-provider configured default.
  const max =
    typeof params.maxTokens === "number" ? params.maxTokens : configuredMax;

  const body: Record<string, unknown> = {
    max_tokens: max,
    messages,
    model: params.model,
    stream: true,
  };

  if (params.systemPrompt) {
    body.system = cacheSystem
      ? [
          {
            cache_control: { type: "ephemeral" },
            text: params.systemPrompt,
            type: "text",
          },
        ]
      : params.systemPrompt;
  }

  if (params.tools && params.tools.length > 0) {
    const tools: Array<Record<string, unknown>> =
      params.tools.map(mapToolDefinition);
    // Tool schemas are the most stable prefix — cache them whenever enabled.
    if (caching) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }
    body.tools = tools;
    if (params.toolChoice === "auto" || params.toolChoice === "none") {
      body.tool_choice = { type: params.toolChoice };
    } else if (params.toolChoice === "required") {
      body.tool_choice = { type: "any" };
    } else if (params.toolChoice && typeof params.toolChoice === "object") {
      body.tool_choice = { name: params.toolChoice.name, type: "tool" };
    }
  }

  if (params.stopSequences && params.stopSequences.length > 0) {
    body.stop_sequences = params.stopSequences;
  }

  const mode = params.reasoning ? anthropicReasoningMode(params.model) : "none";
  const thinkingActive = mode !== "none";

  // Sampling params (temperature/top_p) are rejected outright by Opus 4.7/4.8 and
  // Fable/Mythos, and conflict with thinking on the models that do accept them —
  // so only send them when the model allows sampling AND thinking is off.
  if (!thinkingActive && anthropicSupportsSampling(params.model)) {
    if (typeof params.temperature === "number") {
      body.temperature = params.temperature;
    }
    if (typeof params.topP === "number") body.top_p = params.topP;
  }

  if (mode === "effort" || mode === "adaptive") {
    body.thinking = { type: "adaptive" };
    if (mode === "effort" && params.reasoning) {
      const effort = anthropicEffortValue(params.model, params.reasoning);
      if (effort) body.output_config = { effort };
    }
  } else if (mode === "legacy" && params.reasoning) {
    const budget = resolveBudgetTokens(params.reasoning);
    if (budget) {
      body.thinking = { budget_tokens: budget, type: "enabled" };
      // Extended thinking requires headroom: budget tokens + room to answer.
      body.max_tokens = Math.max(max, budget + max);
    }
  }

  return body;
};

const classifyLine = (line: string) => {
  if (line.startsWith("event: ")) {
    return {
      field: "event" as const,
      value: line.slice(EVENT_PREFIX_LENGTH),
    };
  }

  if (line.startsWith("data: ")) {
    return {
      field: "data" as const,
      value: line.slice(DATA_PREFIX_LENGTH),
    };
  }

  return undefined;
};

const applyClassified = (
  acc: { eventData: string; eventType: string },
  classified: { field: "event" | "data"; value: string } | undefined,
) => {
  if (!classified) {
    return acc;
  }

  if (classified.field === "event") {
    return { eventData: acc.eventData, eventType: classified.value };
  }

  return { eventData: classified.value, eventType: acc.eventType };
};

const parseEventLines = (event: string) =>
  event
    .split("\n")
    .reduce((acc, line) => applyClassified(acc, classifyLine(line)), {
      eventData: "",
      eventType: "",
    });

const safeParse = (text: string) => {
  try {
    const result: unknown = JSON.parse(text);

    return result;
  } catch {
    return undefined;
  }
};

const tryParseJson = (text: string) => {
  const result = safeParse(text);

  if (isRecord(result)) {
    return result;
  }

  return undefined;
};

const getRecord = (obj: Record<string, unknown>, key: string) => {
  const val = obj[key];

  if (isRecord(val)) {
    return val;
  }

  return undefined;
};

const getString = (obj: Record<string, unknown>, key: string) => {
  const val = obj[key];

  if (typeof val === "string") {
    return val;
  }

  return "";
};

const getNumber = (obj: Record<string, unknown>, key: string) => {
  const val = obj[key];

  if (typeof val === "number") {
    return val;
  }

  return 0;
};

const handleContentBlockStart = (
  parsed: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  const block = getRecord(parsed, "content_block");

  if (block && block.type === "tool_use") {
    state.currentToolId = getString(block, "id");
    state.currentToolName = getString(block, "name");
    state.toolInputJson = "";
    state.isThinkingBlock = false;
    state.currentProviderBlock = undefined;
  } else if (block && block.type === "thinking") {
    state.isThinkingBlock = true;
    state.thinkingSignature = "";
    state.currentProviderBlock = undefined;
  } else {
    state.isThinkingBlock = false;
    state.currentProviderBlock =
      block && block.type !== "text" ? { ...block } : undefined;
    state.providerBlockInputJson = "";
  }
};

const handleContentBlockDelta = (
  parsed: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  const delta = getRecord(parsed, "delta");

  if (!delta) {
    return undefined;
  }

  if (delta.type === "thinking_delta") {
    return {
      content: getString(delta, "thinking"),
      type: "thinking",
    } satisfies AIChunk;
  }

  if (delta.type === "text_delta") {
    return {
      content: getString(delta, "text"),
      type: "text",
    } satisfies AIChunk;
  }

  if (delta.type === "input_json_delta") {
    if (state.currentProviderBlock) {
      state.providerBlockInputJson += getString(delta, "partial_json");
    } else {
      state.toolInputJson += getString(delta, "partial_json");
    }
  }

  if (delta.type === "signature_delta") {
    state.thinkingSignature += getString(delta, "signature");
  }

  return undefined;
};

const handleContentBlockStop = (state: AnthropicSSEState) => {
  // Emit thinking signature when thinking block completes
  if (state.isThinkingBlock && state.thinkingSignature) {
    state.isThinkingBlock = false;
    const signature = state.thinkingSignature;
    state.thinkingSignature = "";

    return {
      content: "",
      signature,
      type: "thinking",
    } satisfies AIChunk;
  }

  if (state.currentProviderBlock) {
    const data = { ...state.currentProviderBlock };
    if (state.providerBlockInputJson) {
      data.input =
        tryParseJson(state.providerBlockInputJson) ??
        state.providerBlockInputJson;
    }
    state.currentProviderBlock = undefined;
    state.providerBlockInputJson = "";
    return {
      data,
      provider: state.providerName,
      type: "provider_event",
    } satisfies AIChunk;
  }

  if (!state.currentToolId) {
    return undefined;
  }

  const input = tryParseJson(state.toolInputJson) ?? state.toolInputJson;

  const chunk: AIChunk = {
    id: state.currentToolId,
    input,
    name: state.currentToolName,
    type: "tool_use",
  };

  state.currentToolId = "";
  state.currentToolName = "";
  state.toolInputJson = "";

  return chunk;
};

const extractUsage = (
  usageRecord: Record<string, unknown> | undefined,
  existingUsage: AIUsage | undefined,
) => {
  if (!usageRecord) {
    return existingUsage;
  }

  const normalized: AIUsage = {
    cacheReadInputTokens:
      getNumber(usageRecord, "cache_read_input_tokens") ||
      existingUsage?.cacheReadInputTokens ||
      0,
    cacheWriteInputTokens:
      getNumber(usageRecord, "cache_creation_input_tokens") ||
      existingUsage?.cacheWriteInputTokens ||
      0,
    inputTokens:
      getNumber(usageRecord, "input_tokens") || existingUsage?.inputTokens || 0,
    outputTokens:
      getNumber(usageRecord, "output_tokens") ||
      existingUsage?.outputTokens ||
      0,
    costCredits:
      getNumber(usageRecord, "cost") || existingUsage?.costCredits,
    reasoningTokens:
      getNumber(usageRecord, "reasoning_tokens") ||
      existingUsage?.reasoningTokens,
    upstreamInferenceCostCredits:
      getNumber(getRecord(usageRecord, "cost_details") ?? {}, "upstream_inference_cost") ||
      existingUsage?.upstreamInferenceCostCredits,
  };
  const serverToolUse = getRecord(usageRecord, "server_tool_use");
  if (serverToolUse) {
    normalized.serverToolUse = Object.fromEntries(
      Object.entries(serverToolUse).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  }

  return normalized;
};

const mergeMetadata = (
  source: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  const providerMetadata = getRecord(source, "openrouter_metadata");
  const generationId = getString(source, "id") || undefined;
  const model = getString(source, "model") || undefined;
  const provider = getString(source, "provider") || undefined;
  const serviceTier = getString(source, "service_tier") || undefined;
  if (!providerMetadata && !generationId && !model && !provider && !serviceTier)
    return;
  state.metadata = {
    ...state.metadata,
    generationId: generationId ?? state.metadata?.generationId,
    model: model ?? state.metadata?.model,
    provider: provider ?? state.metadata?.provider,
    providerMetadata: {
      ...state.metadata?.providerMetadata,
      ...providerMetadata,
    },
    serviceTier: serviceTier ?? state.metadata?.serviceTier,
  };
};

const handleMessageDelta = (
  parsed: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  const deltaUsage = getRecord(parsed, "usage");
  state.usage = extractUsage(deltaUsage, state.usage);

  const delta = getRecord(parsed, "delta");
  const stopReason = delta ? getString(delta, "stop_reason") : "";
  if (stopReason) state.stopReason = stopReason;
};

const handleMessageStart = (
  parsed: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  const message = getRecord(parsed, "message");

  if (!message) {
    return;
  }

  const startUsage = getRecord(message, "usage");
  state.usage = extractUsage(startUsage, state.usage);
  mergeMetadata(message, state);
};

const handleError = (
  parsed: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  const error = getRecord(parsed, "error");
  const errorMessage = error ? getString(error, "message") : "";
  const nativeErrorType = error ? getString(error, "type") : "";
  const errorType = error
    ? getString(error, "error_type") || nativeErrorType
    : "";

  // Mid-stream error events (e.g. "overloaded_error") — overloaded/rate-limit
  // types are retryable; everything else is treated as a hard failure.
  const retryable =
    errorType === "provider_overloaded" ||
    errorType === "rate_limit_exceeded" ||
    errorType === "provider_unavailable" ||
    errorType === "server" ||
    nativeErrorType === "overloaded_error" ||
    nativeErrorType === "rate_limit_error" ||
    nativeErrorType === "api_error";

  throw new ProviderError({
    message: errorMessage || "Anthropic API error",
    metadata: error,
    provider: state.providerName,
    retryable,
    type: errorType || null,
  });
};

const processEvent = (
  eventType: string,
  parsed: Record<string, unknown>,
  state: AnthropicSSEState,
) => {
  switch (eventType) {
    case "content_block_start": {
      handleContentBlockStart(parsed, state);

      return undefined;
    }

    case "content_block_delta": {
      return handleContentBlockDelta(parsed, state);
    }

    case "content_block_stop": {
      return handleContentBlockStop(state);
    }

    case "message_delta": {
      handleMessageDelta(parsed, state);
      mergeMetadata(parsed, state);

      return undefined;
    }

    case "message_start": {
      handleMessageStart(parsed, state);

      return undefined;
    }

    case "message_stop": {
      mergeMetadata(parsed, state);
      return {
        stopReason: state.stopReason,
        metadata: state.metadata,
        type: "done" as const,
        usage: state.usage,
      };
    }

    case "error": {
      handleError(parsed, state);

      return undefined;
    }

    default: {
      return undefined;
    }
  }
};

const processSingleEvent = (event: string, state: AnthropicSSEState) => {
  if (!event.trim()) {
    return undefined;
  }

  const { eventData, eventType } = parseEventLines(event);

  if (!eventData) {
    return undefined;
  }

  const parsed = tryParseJson(eventData);

  if (!parsed) {
    return undefined;
  }

  return processEvent(eventType, parsed, state);
};

const collectChunk = (event: string, state: AnthropicSSEState) => {
  const chunk = processSingleEvent(event, state);

  return chunk ? [chunk] : [];
};

const processBufferedEvents = (
  eventsText: string,
  state: AnthropicSSEState,
) => {
  const events = eventsText.split("\n\n");
  state.buffer = events.pop() ?? "";

  return events.flatMap((event) => collectChunk(event, state));
};

const readNextChunks = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: AnthropicSSEState,
  signal?: AbortSignal,
) => {
  if (signal?.aborted) {
    return { chunks: EMPTY_CHUNKS, done: true };
  }

  const { done, value } = await reader.read();

  if (done) {
    return { chunks: EMPTY_CHUNKS, done: true };
  }

  const rawText = state.buffer + decoder.decode(value, { stream: true });
  const chunks = processBufferedEvents(rawText, state);

  return { chunks, done: false };
};

const findDoneChunk = (chunks: AIChunk[]) =>
  chunks.findIndex((c) => c.type === "done");

const sseStreamLoop = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: AnthropicSSEState,
  signal?: AbortSignal,
) => {
  const result = await readNextChunks(reader, decoder, state, signal);

  if (result.done) {
    return { chunks: result.chunks, finished: true };
  }

  const doneIdx = findDoneChunk(result.chunks);

  if (doneIdx >= 0) {
    return { chunks: result.chunks.slice(0, doneIdx + 1), finished: true };
  }

  return { chunks: result.chunks, finished: false };
};

// eslint-disable-next-line func-style
async function* streamChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: AnthropicSSEState,
  signal?: AbortSignal,
) {
  let finished = false;

  while (!finished) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sseStreamLoop(reader, decoder, state, signal);
    ({ finished } = result);
    yield* result.chunks;
  }
}

// eslint-disable-next-line func-style
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  providerName: string,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  const state: AnthropicSSEState = {
    buffer: "",
    currentToolId: "",
    currentToolName: "",
    isThinkingBlock: false,
    stopReason: "",
    thinkingSignature: "",
    toolInputJson: "",
    usage: undefined,
    providerName,
    providerBlockInputJson: "",
  };

  try {
    yield* streamChunks(reader, decoder, state, signal);
  } finally {
    reader.releaseLock();
  }
}

const fetchAndStream = async function* (
  baseUrl: string,
  config: AnthropicConfig,
  params: AIProviderStreamParams,
  configuredMax: number,
  promptCaching: boolean,
  providerName: string,
) {
  const builtBody = buildRequestBody(params, configuredMax, promptCaching);
  const body = config.transformRequestBody
    ? config.transformRequestBody(builtBody, params)
    : builtBody;

  const target = `${baseUrl}/v1/messages`;
  const fetchImpl = config.fetch ?? fetch;
  const token = config.tokenSource
    ? await Promise.resolve(config.tokenSource())
    : config.apiKey!;
  const suppliedHeaders =
    typeof config.headers === "function"
      ? await config.headers(params)
      : (config.headers ?? {});
  const requestHeaders = new Headers(suppliedHeaders);
  requestHeaders.set("Content-Type", "application/json");
  if (config.authStyle === "bearer") {
    requestHeaders.set("Authorization", `Bearer ${token}`);
  } else {
    requestHeaders.set("anthropic-version", API_VERSION);
    requestHeaders.set("x-api-key", token);
  }
  const response = await fetchImpl(target, {
    ...h2IfHttps(target),
    body: JSON.stringify(body),
    headers: requestHeaders,
    method: "POST",
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw ProviderError.fromResponse(providerName, response.status, errorText);
  }

  if (!response.body) {
    throw new ProviderError({
      message: `${providerName} Messages API returned no response body`,
      provider: providerName,
      retryable: true,
    });
  }

  yield* parseSSEStream(response.body, providerName, params.signal);
};

export const anthropic = (config: AnthropicConfig): AIProviderConfig => {
  if (!config.apiKey && !config.tokenSource)
    throw new Error("anthropic() requires either apiKey or tokenSource");
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const configuredMax = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promptCaching = config.promptCaching ?? true;
  const providerName = config.providerName ?? "anthropic";

  return instrumentAIProvider(
    {
      stream: (params: AIProviderStreamParams) =>
        fetchAndStream(
          baseUrl,
          config,
          params,
          configuredMax,
          promptCaching,
          providerName,
        ),
    },
    providerName,
  );
};
