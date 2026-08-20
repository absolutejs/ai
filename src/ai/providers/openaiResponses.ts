import type {
  AIProviderConfig,
  AIProviderContentBlock,
  AIProviderMessage,
  AIProviderStreamParams,
  AIProviderToolDefinition,
  AIUsage,
  AIResponseMetadata,
} from "../../../types/ai";
import { instrumentAIProvider } from "./instrumentation";
import { ProviderError } from "../errors/providerError";
import { isOpenAIReasoningModel, openaiEffortValue } from "./reasoning";

// Opportunistic HTTP/2 multiplexing for outbound HTTPS (Bun 1.3.14+).
// The `protocol` option lands in @types/bun 1.3.14; widen locally for now.
// Hard-skip on non-HTTPS — Bun's h2 client throws HTTP2Unsupported on h2c.
type H2Init = RequestInit & { protocol?: "http2" };
const h2IfHttps = (url: string): H2Init =>
  url.startsWith("https://") ? { protocol: "http2" } : {};

export type OpenAIResponsesConfig = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?:
    | HeadersInit
    | ((params: AIProviderStreamParams) => HeadersInit | Promise<HeadersInit>);
  imageModels?: Set<string> | string[];
  modelForCapabilities?: (model: string) => string;
  providerName?: string;
  tokenSource?: () => Promise<string> | string;
  transformRequestBody?: (
    body: Record<string, unknown>,
    params: AIProviderStreamParams,
  ) => Record<string, unknown>;
};

type PendingFunctionCall = {
  callId: string;
  name: string;
  arguments: string;
  providerData?: Record<string, unknown>;
};

type StreamState = {
  buffer: string;
  currentEvent: string;
  pendingCalls: Map<string, PendingFunctionCall>;
  usage: AIUsage | undefined;
  providerName: string;
};

const DEFAULT_BASE_URL = "https://api.openai.com";
const EVENT_PREFIX_LENGTH = 7;
const DATA_PREFIX_LENGTH = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRecordArray = (
  value: unknown,
): value is Array<Record<string, unknown>> =>
  Array.isArray(value) && value.length > 0 && isRecord(value[0]);

/* ─── Message conversion ─── */

const mapBlockToResponsesFormat = (block: AIProviderContentBlock) => {
  if (block.type === "text") {
    return { text: block.content, type: "input_text" };
  }

  if (block.type === "image") {
    return {
      image_url: {
        url:
          block.source.type === "url"
            ? block.source.url
            : `data:${block.source.media_type};base64,${block.source.data}`,
      },
      type: "input_image",
    };
  }

  if (block.type === "document") {
    return {
      file: {
        file_data:
          block.source.type === "url"
            ? block.source.url
            : `data:${block.source.media_type};base64,${block.source.data}`,
        filename: block.name ?? "document.pdf",
      },
      type: "input_file",
    };
  }

  if (block.type === "audio") {
    return {
      input_audio: { data: block.source.data, format: block.source.format },
      type: "input_audio",
    };
  }

  if (block.type === "video") {
    return {
      type: "input_video",
      video_url:
        block.source.type === "url"
          ? block.source.url
          : `data:${block.source.media_type};base64,${block.source.data}`,
    };
  }

  return null;
};

const mapContentToResponsesFormat = (
  content: string | AIProviderContentBlock[],
) => {
  if (typeof content === "string") {
    return content;
  }

  const parts = content
    .map(mapBlockToResponsesFormat)
    .filter((mapped) => mapped !== null);

  return parts.length > 0 ? parts : "";
};

const hasToolBlocks = (content: AIProviderContentBlock[]) =>
  content.some(
    (block) => block.type === "tool_use" || block.type === "tool_result",
  );

const convertToolBlock = (block: AIProviderContentBlock) => {
  if (block.type === "provider_data" && block.provider === "openrouter") {
    return { ...block.data };
  }

  if (block.type === "tool_use") {
    if (block.providerData) return { ...block.providerData };
    return {
      arguments:
        typeof block.input === "string"
          ? block.input
          : JSON.stringify(block.input),
      call_id: block.id,
      name: block.name,
      type: "function_call",
    };
  }

  if (block.type === "tool_result") {
    return {
      call_id: block.tool_use_id,
      output: typeof block.content === "string" ? block.content : "",
      type: "function_call_output",
    };
  }

  return null;
};

const convertToolBlocks = (content: AIProviderContentBlock[]) =>
  content.map(convertToolBlock).filter((converted) => converted !== null);

const convertMessage = (msg: AIProviderMessage) => {
  if (
    typeof msg.content !== "string" &&
    Array.isArray(msg.content) &&
    hasToolBlocks(msg.content)
  ) {
    return convertToolBlocks(msg.content);
  }

  const content = mapContentToResponsesFormat(msg.content);

  return [
    {
      content,
      role: msg.role === "system" ? "developer" : msg.role,
      type: "message",
    },
  ];
};

const buildInput = (messages: AIProviderMessage[]) => {
  const input: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    input.push(...convertMessage(msg));
  }

  return input;
};

const mapToolDefinition = (tool: AIProviderToolDefinition) => ({
  description: tool.description,
  name: tool.name,
  parameters: tool.input_schema,
  type: "function",
});

const buildTools = (
  tools: AIProviderToolDefinition[] | undefined,
  isImageModel: boolean,
) => {
  const mapped = tools ? tools.map(mapToolDefinition) : [];
  const result: Array<Record<string, unknown>> = [...mapped];

  if (isImageModel) {
    result.push({ type: "image_generation" });
  }

  return result.length > 0 ? result : undefined;
};

const buildRequestBody = (
  params: AIProviderStreamParams,
  isImageModel: boolean,
  capabilityModel = params.model,
) => {
  const body: Record<string, unknown> = {
    input: buildInput(params.messages),
    model: params.model,
    stream: true,
  };

  if (params.systemPrompt) {
    body.instructions = params.systemPrompt;
  }

  const tools = buildTools(params.tools, isImageModel);

  if (tools) {
    body.tools = tools;
    if (
      params.toolChoice === "auto" ||
      params.toolChoice === "none" ||
      params.toolChoice === "required"
    ) {
      body.tool_choice = params.toolChoice;
    } else if (params.toolChoice && typeof params.toolChoice === "object") {
      body.tool_choice = {
        name: params.toolChoice.name,
        type: "function",
      };
    }
    if (typeof params.parallelToolCalls === "boolean") {
      body.parallel_tool_calls = params.parallelToolCalls;
    }
  }

  if (typeof params.temperature === "number")
    body.temperature = params.temperature;
  if (typeof params.topP === "number") body.top_p = params.topP;
  if (typeof params.maxTokens === "number")
    body.max_output_tokens = params.maxTokens;
  if (params.stopSequences && params.stopSequences.length > 0)
    body.stop = params.stopSequences;
  if (typeof params.seed === "number") body.seed = params.seed;
  if (typeof params.frequencyPenalty === "number")
    body.frequency_penalty = params.frequencyPenalty;
  if (typeof params.presencePenalty === "number")
    body.presence_penalty = params.presencePenalty;

  if (params.responseFormat) {
    if (
      params.responseFormat.type === "text" ||
      params.responseFormat.type === "json_object"
    ) {
      body.text = { format: { type: params.responseFormat.type } };
    } else if (params.responseFormat.type === "json_schema") {
      body.text = {
        format: {
          name: params.responseFormat.name,
          schema: params.responseFormat.schema,
          strict: params.responseFormat.strict ?? true,
          type: "json_schema",
        },
      };
    }
  }

  // Reasoning models take a `reasoning.effort` dial; non-reasoning models ignore
  // it. Effort comes from the portable `reasoning` knob, mapped per model.
  if (params.reasoning && isOpenAIReasoningModel(capabilityModel)) {
    const effort = openaiEffortValue(capabilityModel, params.reasoning);
    if (effort) {
      body.reasoning = {
        effort,
        summary: "auto",
      };
    }
  }

  return body;
};

/* ─── SSE parsing ─── */

const parseJSON = (data: string) => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const parseToolInput = (rawArguments: string) => {
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
};

const extractUsage = (response: Record<string, unknown>) => {
  if (!isRecord(response.usage)) {
    return undefined;
  }

  const { usage } = response;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  // input_tokens INCLUDES cached input; split it out so the cached portion is
  // discounted (mirrors Anthropic) instead of billed at the full input rate.
  const cached =
    isRecord(usage.input_tokens_details) &&
    typeof usage.input_tokens_details.cached_tokens === "number"
      ? usage.input_tokens_details.cached_tokens
      : 0;

  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : undefined;
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : undefined;
  const costDetails = isRecord(usage.cost_details)
    ? usage.cost_details
    : undefined;
  const normalized: AIUsage = {
    cacheReadInputTokens: cached,
    cacheWriteInputTokens:
      inputDetails && typeof inputDetails.cache_write_tokens === "number"
        ? inputDetails.cache_write_tokens
        : undefined,
    costCredits: typeof usage.cost === "number" ? usage.cost : undefined,
    inputTokens: Math.max(0, input - cached),
    outputTokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    reasoningTokens:
      outputDetails && typeof outputDetails.reasoning_tokens === "number"
        ? outputDetails.reasoning_tokens
        : undefined,
    upstreamInferenceCostCredits:
      costDetails && typeof costDetails.upstream_inference_cost === "number"
        ? costDetails.upstream_inference_cost
        : undefined,
  };
  if (isRecord(usage.server_tool_use)) {
    normalized.serverToolUse = Object.fromEntries(
      Object.entries(usage.server_tool_use).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  }

  return normalized;
};

const extractResponseMetadata = (
  response: Record<string, unknown>,
): AIResponseMetadata | undefined => {
  const providerMetadata = isRecord(response.openrouter_metadata)
    ? response.openrouter_metadata
    : undefined;
  const generationId = typeof response.id === "string" ? response.id : undefined;
  const model = typeof response.model === "string" ? response.model : undefined;
  const provider =
    typeof response.provider === "string" ? response.provider : undefined;
  const serviceTier =
    typeof response.service_tier === "string"
      ? response.service_tier
      : undefined;
  if (!providerMetadata && !generationId && !model && !provider && !serviceTier)
    return;
  return { generationId, model, provider, providerMetadata, serviceTier };
};

const extractMimeFormat = (mimeType: unknown) => {
  if (typeof mimeType !== "string") {
    return "png";
  }

  if (mimeType.includes("jpeg")) return "jpeg";
  if (mimeType.includes("webp")) return "webp";

  return "png";
};

const processTextDelta = function* (parsed: Record<string, unknown>) {
  if (typeof parsed.delta === "string") {
    yield { content: parsed.delta, type: "text" as const };
  }
};

const processPartialImage = function* (parsed: Record<string, unknown>) {
  const itemId =
    typeof parsed.item_id === "string" ? parsed.item_id : undefined;
  const b64 =
    typeof parsed.partial_image_b64 === "string"
      ? parsed.partial_image_b64
      : undefined;

  if (b64) {
    yield {
      data: b64,
      format: "png",
      imageId: itemId,
      isPartial: true,
      type: "image" as const,
    };
  }
};

const processFunctionCallArgumentsDelta = (
  parsed: Record<string, unknown>,
  pendingCalls: Map<string, PendingFunctionCall>,
) => {
  const itemId = typeof parsed.item_id === "string" ? parsed.item_id : "";
  const callId = typeof parsed.call_id === "string" ? parsed.call_id : "";
  const delta =
    typeof parsed.arguments_delta === "string" ? parsed.arguments_delta : "";

  const existing = pendingCalls.get(itemId);

  if (existing) {
    existing.arguments += delta;
  } else {
    pendingCalls.set(itemId, {
      arguments: delta,
      callId,
      name: "",
    });
  }
};

const processFunctionCallArgumentsDone = function* (
  parsed: Record<string, unknown>,
  pendingCalls: Map<string, PendingFunctionCall>,
) {
  const itemId = typeof parsed.item_id === "string" ? parsed.item_id : "";
  const callId = typeof parsed.call_id === "string" ? parsed.call_id : "";
  const fullArgs = typeof parsed.arguments === "string" ? parsed.arguments : "";

  const pending = pendingCalls.get(itemId);
  const name = pending?.name ?? "";
  const args = fullArgs || pending?.arguments || "";

  pendingCalls.delete(itemId);

  yield {
    id: callId || pending?.callId || itemId,
    input: parseToolInput(args),
    name,
    providerData: pending?.providerData
      ? { ...pending.providerData, arguments: args }
      : undefined,
    type: "tool_use" as const,
  };
};

const processOutputItemAdded = (
  parsed: Record<string, unknown>,
  pendingCalls: Map<string, PendingFunctionCall>,
) => {
  if (!isRecord(parsed.item)) {
    return;
  }

  const { item } = parsed;
  const itemId = typeof item.id === "string" ? item.id : "";
  const itemType = typeof item.type === "string" ? item.type : "";

  if (itemType !== "function_call") {
    return;
  }

  const callId = typeof item.call_id === "string" ? item.call_id : "";
  const name = typeof item.name === "string" ? item.name : "";

  pendingCalls.set(itemId, {
    arguments: "",
    callId,
    name,
    providerData: { ...item },
  });
};

const processOutputItemDone = function* (parsed: Record<string, unknown>) {
  if (!isRecord(parsed.item) || typeof parsed.item.type !== "string") return;
  if (!parsed.item.type.startsWith("openrouter:")) return;
  yield {
    data: { ...parsed.item },
    provider: "openrouter",
    type: "provider_event" as const,
  };
};

const isCompletedImageGeneration = (item: Record<string, unknown>) =>
  item.type === "image_generation_call" &&
  item.status === "completed" &&
  typeof item.result === "string" &&
  item.result !== "";

const buildImageChunk = (item: Record<string, unknown>) => ({
  data: typeof item.result === "string" ? item.result : "",
  format: extractMimeFormat(item.output_format),
  imageId: typeof item.id === "string" ? item.id : undefined,
  isPartial: false,
  revisedPrompt:
    typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
  type: "image" as const,
});

const extractImageFromOutput = function* (
  output: Array<Record<string, unknown>>,
) {
  const completedImages = output.filter(isCompletedImageGeneration);

  for (const item of completedImages) {
    yield buildImageChunk(item);
  }
};

const extractCitationsFromOutput = function* (
  output: Array<Record<string, unknown>>,
) {
  for (const item of output) {
    if (!isRecordArray(item.content)) continue;
    for (const content of item.content) {
      if (!Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation")
          continue;
        if (typeof annotation.url !== "string") continue;
        yield {
          content:
            typeof annotation.content === "string"
              ? annotation.content
              : undefined,
          endIndex:
            typeof annotation.end_index === "number"
              ? annotation.end_index
              : undefined,
          startIndex:
            typeof annotation.start_index === "number"
              ? annotation.start_index
              : undefined,
          title:
            typeof annotation.title === "string"
              ? annotation.title
              : undefined,
          type: "citation" as const,
          url: annotation.url,
        };
      }
    }
  }
};

const processCompleted = function* (parsed: Record<string, unknown>) {
  if (!isRecord(parsed.response)) {
    yield { type: "done" as const, usage: undefined };

    return;
  }

  const { response } = parsed;
  const usage = extractUsage(response);
  const metadata = extractResponseMetadata(response);

  if (isRecordArray(response.output)) {
    yield* extractCitationsFromOutput(response.output);
    yield* extractImageFromOutput(response.output);
  }

  yield { metadata, type: "done" as const, usage };
};

const responseFailure = (
  eventType: string,
  parsed: Record<string, unknown>,
  providerName: string,
) => {
  const response = isRecord(parsed.response) ? parsed.response : parsed;
  const error = isRecord(response.error) ? response.error : undefined;
  const type =
    typeof response.error_type === "string"
      ? response.error_type
      : error && typeof error.code === "string"
        ? error.code
        : eventType;
  return new ProviderError({
    message:
      error && typeof error.message === "string"
        ? error.message
        : `OpenRouter Responses API: ${eventType}`,
    metadata: response,
    provider: providerName,
    retryable:
      type === "rate_limit_exceeded" ||
      type === "provider_overloaded" ||
      type === "provider_unavailable" ||
      type === "server",
    type,
  });
};

const processSSEEvent = function* (
  eventType: string,
  parsed: Record<string, unknown>,
  pendingCalls: Map<string, PendingFunctionCall>,
  providerName: string,
) {
  switch (eventType) {
    case "response.reasoning_summary_text.delta": {
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      if (!delta) break;

      yield {
        content: delta,
        type: "thinking" as const,
      };

      break;
    }

    case "response.output_text.delta":
      yield* processTextDelta(parsed);
      break;

    case "response.image_generation_call.partial_image":
      yield* processPartialImage(parsed);
      break;

    case "response.output_item.added":
      processOutputItemAdded(parsed, pendingCalls);
      break;

    case "response.output_item.done":
      yield* processOutputItemDone(parsed);
      break;

    case "response.function_call_arguments.delta":
      processFunctionCallArgumentsDelta(parsed, pendingCalls);
      break;

    case "response.function_call_arguments.done":
      yield* processFunctionCallArgumentsDone(parsed, pendingCalls);
      break;

    case "response.completed":
      yield* processCompleted(parsed);
      break;

    case "response.failed":
    case "response.incomplete":
    case "response.error":
    case "error":
      throw responseFailure(eventType, parsed, providerName);
  }
};

const flushSSEBuffer = function* (state: StreamState) {
  if (!state.currentEvent || !state.buffer) {
    return;
  }

  const parsed = parseJSON(state.buffer);

  if (parsed) {
    yield* processSSEEvent(
      state.currentEvent,
      parsed,
      state.pendingCalls,
      state.providerName,
    );
  }

  state.currentEvent = "";
  state.buffer = "";
};

const parseSSELine = (trimmed: string, state: StreamState) => {
  if (trimmed.startsWith("event: ")) {
    state.currentEvent = trimmed.slice(EVENT_PREFIX_LENGTH);
  } else if (trimmed.startsWith("data: ")) {
    state.buffer = trimmed.slice(DATA_PREFIX_LENGTH);
  }
};

const processSSELine = function* (line: string, state: StreamState) {
  const trimmed = line.trim();

  if (trimmed) {
    parseSSELine(trimmed, state);

    return;
  }

  yield* flushSSEBuffer(state);
};

const processSSELines = function* (lines: string[], state: StreamState) {
  for (const line of lines) {
    yield* processSSELine(line, state);
  }
};

const drainReader = async function* (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: StreamState,
  signal?: AbortSignal,
) {
  let textBuffer = "";

  for (
    let result = await reader.read();
    !result.done && !signal?.aborted;
    // eslint-disable-next-line no-await-in-loop
    result = await reader.read()
  ) {
    textBuffer += decoder.decode(result.value, { stream: true });
    const lines = textBuffer.split("\n");
    textBuffer = lines.pop() ?? "";

    yield* processSSELines(lines, state);
  }

  if (textBuffer.trim()) {
    yield* processSSELines([textBuffer, ""], state);
  }
};

const parseSSEStream = async function* (
  body: ReadableStream<Uint8Array>,
  providerName: string,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = {
    buffer: "",
    currentEvent: "",
    pendingCalls: new Map(),
    usage: undefined,
    providerName,
  };

  try {
    yield* drainReader(reader, decoder, state, signal);
    yield* flushSSEBuffer(state);
  } finally {
    reader.releaseLock();
  }
};

const fetchResponsesStream = async function* (
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
  headers: HeadersInit,
  providerName: string,
  signal?: AbortSignal,
) {
  const target = `${baseUrl}/v1/responses`;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Authorization", `Bearer ${apiKey}`);
  requestHeaders.set("Content-Type", "application/json");
  const response = await fetchImpl(target, {
    ...h2IfHttps(target),
    body: JSON.stringify(body),
    headers: requestHeaders,
    method: "POST",
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw ProviderError.fromResponse(providerName, response.status, errorText);
  }

  if (!response.body) {
    throw new ProviderError({
      message: `${providerName} Responses API returned no response body`,
      provider: providerName,
      retryable: true,
    });
  }

  yield* parseSSEStream(response.body, providerName, signal);
};

const resolveImageModels = (
  imageModels: Set<string> | string[] | undefined,
) => {
  if (!imageModels) {
    return new Set<string>();
  }

  if (imageModels instanceof Set) {
    return imageModels;
  }

  return new Set(imageModels);
};

export const openaiResponses = (config: OpenAIResponsesConfig) => {
  if (!config.apiKey && !config.tokenSource)
    throw new Error("openaiResponses() requires either apiKey or tokenSource");
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const imageModels = resolveImageModels(config.imageModels);
  const providerName = config.providerName ?? "openai-responses";
  const resolveKey = async () =>
    config.tokenSource
      ? await Promise.resolve(config.tokenSource())
      : config.apiKey!;
  const resolveHeaders = async (params: AIProviderStreamParams) =>
    typeof config.headers === "function"
      ? await config.headers(params)
      : (config.headers ?? {});

  return instrumentAIProvider(
    {
      stream: (params: AIProviderStreamParams) => {
        const isImageModel = imageModels.has(params.model);
        const builtBody = buildRequestBody(
          params,
          isImageModel,
          config.modelForCapabilities?.(params.model) ?? params.model,
        );
        const body = config.transformRequestBody
          ? config.transformRequestBody(builtBody, params)
          : builtBody;
        return (async function* () {
          const [apiKey, headers] = await Promise.all([
            resolveKey(),
            resolveHeaders(params),
          ]);
          yield* fetchResponsesStream(
            baseUrl,
            apiKey,
            body,
            fetchImpl,
            headers,
            providerName,
            params.signal,
          );
        })();
      },
    } satisfies AIProviderConfig,
    providerName,
  );
};
