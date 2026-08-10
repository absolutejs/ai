import type { SessionStore } from "./session";

export type AIUsage = {
  /** Anthropic prompt-cache reads (billed at 0.10x input). Omitted when unused. */
  cacheReadInputTokens?: number;
  /** Anthropic prompt-cache writes (billed at 1.25x input). Omitted when unused. */
  cacheWriteInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
};

export type RAGSource = {
  chunkId: string;
  corpusKey?: string;
  score: number;
  text: string;
  title?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  labels?: RAGSourceLabels;
  structure?: RAGChunkStructure;
};

export type RAGHybridRetrievalMode = "vector" | "lexical" | "hybrid";

export type RAGSourceBalanceStrategy = "cap" | "round_robin";

export type RAGDiversityStrategy = "none" | "mmr";

export type RAGSourceLabels = {
  contextLabel?: string;
  locatorLabel?: string;
  provenanceLabel?: string;
};

export type RAGChunkSection = {
  title?: string;
  path?: string[];
  depth?: number;
  kind?:
    | "markdown_heading"
    | "html_heading"
    | "office_heading"
    | "office_block"
    | "pdf_block"
    | "spreadsheet_rows"
    | "presentation_slide";
};

export type RAGChunkSequence = {
  sectionChunkId?: string;
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  previousChunkId?: string;
  nextChunkId?: string;
};

export type RAGChunkStructure = {
  section?: RAGChunkSection;
  sequence?: RAGChunkSequence;
};

export type RAGRetrievalTraceStage =
  | "input"
  | "query_transform"
  | "routing"
  | "embed"
  | "vector_search"
  | "lexical_search"
  | "fusion"
  | "rerank"
  | "diversity"
  | "source_balance"
  | "evidence_reconcile"
  | "score_filter"
  | "finalize";

export type RAGRetrievalTraceStep = {
  stage: RAGRetrievalTraceStage;
  label: string;
  durationMs?: number;
  count?: number;
  sectionCounts?: Array<{
    key: string;
    label: string;
    count: number;
  }>;
  sectionScores?: Array<{
    key: string;
    label: string;
    totalScore: number;
  }>;
  metadata?: Record<string, string | number | boolean | null>;
};

export type RAGRetrievalTrace = {
  query: string;
  transformedQuery: string;
  variantQueries: string[];
  queryTransformProvider?: string;
  queryTransformLabel?: string;
  queryTransformReason?: string;
  topK: number;
  candidateTopK: number;
  lexicalTopK: number;
  requestedMode?: RAGHybridRetrievalMode;
  maxResultsPerSource?: number;
  sourceBalanceStrategy?: RAGSourceBalanceStrategy;
  diversityStrategy?: RAGDiversityStrategy;
  mmrLambda?: number;
  mode: RAGHybridRetrievalMode;
  routingProvider?: string;
  routingLabel?: string;
  routingReason?: string;
  runVector: boolean;
  runLexical: boolean;
  scoreThreshold?: number;
  resultCounts: {
    vector: number;
    lexical: number;
    fused: number;
    reranked: number;
    final: number;
  };
  multiVector?: {
    configured: boolean;
    vectorVariantHits: number;
    lexicalVariantHits: number;
    collapsedParents: number;
  };
  steps: RAGRetrievalTraceStep[];
};

export type AITextChunk = {
  type: "text";
  content: string;
};

export type AIToolUseChunk = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type AIDoneChunk = {
  type: "done";
  usage?: AIUsage;
  stopReason?: string;
};

export type AIThinkingChunk = {
  type: "thinking";
  content: string;
  signature?: string;
};

export type AIImageChunk = {
  type: "image";
  data: string;
  format: string;
  isPartial: boolean;
  revisedPrompt?: string;
  imageId?: string;
};

export type AIUsageUpdateChunk = {
  type: "usage_update";
  usage: AIUsage;
};

export type AIChunk =
  | AITextChunk
  | AIThinkingChunk
  | AIToolUseChunk
  | AIImageChunk
  | AIUsageUpdateChunk
  | AIDoneChunk;

export type AIProviderToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string };

export type AIProviderResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
      type: "json_schema";
    };

/**
 * Portable reasoning effort. Maps to each provider's native control:
 * Anthropic `output_config.effort` (modern models) or a derived `budget_tokens`
 * (legacy models); OpenAI `reasoning.effort` (reasoning models only); Gemini
 * `thinkingConfig.thinkingBudget`. Providers/models that don't support reasoning
 * ignore it. `"minimal"` is clamped up to the nearest supported level where a
 * provider lacks it.
 */

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "max";

/**
 * Provider-agnostic reasoning request. Set `effort` (the portable primitive) and
 * the active provider translates it to the right wire shape for the named model.
 * `budgetTokens` is an explicit escape hatch for budget-based providers
 * (legacy Anthropic extended thinking, Gemini) — ignored by effort-only
 * providers; when both are set, `budgetTokens` wins where the provider uses it.
 */

export type ReasoningConfig = {
  budgetTokens?: number;
  effort?: ReasoningEffort;
};

export type AIProviderStreamParams = {
  /**
   * Mark the system prompt as cacheable (Anthropic prompt caching). The system
   * block is sent with `cache_control: ephemeral`, so repeated calls reusing the
   * same prefix within the cache TTL read it at 0.10x instead of full input cost.
   * Only honored by providers that support prompt caching; ignored otherwise.
   */
  cacheSystemPrompt?: boolean;
  frequencyPenalty?: number;
  maxTokens?: number;
  messages: AIProviderMessage[];
  model: string;
  onSpan?: (span: {
    durationMs: number;
    model: string;
    provider?: string;
    usage?: AIUsage;
  }) => void;
  onUsage?: (usage: AIUsage & { model: string; provider?: string }) => void;
  parallelToolCalls?: boolean;
  presencePenalty?: number;
  /**
   * Per-call override for the provider's `promptCaching` default. Leave unset to
   * inherit the provider config. Set `false` to skip ALL cache breakpoints for
   * this one call — useful for a known one-shot with a large, unique prompt that
   * won't be reused within the cache TTL (a cache write costs 1.25x, so writing
   * a cache nobody reads is pure waste). Set `true` to force caching on for this
   * call even if the provider default is off.
   */
  promptCaching?: boolean;
  /** The one reasoning knob. Set `effort` (portable) and the active provider
   *  emits the right wire shape for the named model — `output_config.effort` +
   *  adaptive thinking on modern Anthropic models, derived `budget_tokens` on
   *  legacy ones, `reasoning.effort` on OpenAI reasoning models, ignored where
   *  unsupported. */
  reasoning?: ReasoningConfig;
  responseFormat?: AIProviderResponseFormat;
  seed?: number;
  signal?: AbortSignal;
  stopSequences?: string[];
  systemPrompt?: string;
  temperature?: number;
  toolChoice?: AIProviderToolChoice;
  tools?: AIProviderToolDefinition[];
  topP?: number;
};

export type AIProviderMessage = {
  role: "user" | "assistant" | "system";
  content: string | AIProviderContentBlock[];
};

export type AIImageSource = {
  type: "base64";
  data: string;
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
};

export type AIDocumentSource = {
  type: "base64";
  data: string;
  media_type: "application/pdf";
};

export type AIProviderContentBlock =
  | { type: "text"; content: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "image"; source: AIImageSource }
  | { type: "document"; source: AIDocumentSource; name?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type AIProviderToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AIProviderConfig = {
  stream: (params: AIProviderStreamParams) => AsyncIterable<AIChunk>;
};

/* ─── Tool types ─── */

/** MCP-shaped behavior hints (all optional). Consumers exposing an AIToolMap
 *  over MCP pass these straight through as the tool's `annotations`; the ai
 *  package's own loops ignore them. readOnlyHint: no state changes at all.
 *  destructiveHint: may delete/overwrite (defaults true for writes per MCP —
 *  set false explicitly for additive-only writes like queueing a draft). */
export type AIToolAnnotations = {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
  title?: string;
};

export type AIToolDefinition = {
  description: string;
  input: Record<string, unknown>;
  handler: (input: unknown) => Promise<string> | string;
  annotations?: AIToolAnnotations;
};

export type AIToolMap = Record<string, AIToolDefinition>;

/* ─── Wire protocol: Client → Server ─── */

export type AIAttachment = {
  data: string;
  media_type:
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp"
    | "application/pdf";
  name?: string;
};

export type AIMessageRequest = {
  type: "message";
  content: string;
  conversationId?: string;
  /** Stable client identity used for queue acknowledgements. */
  messageId?: string;
  attachments?: AIAttachment[];
};

export type AICancelRequest = {
  type: "cancel";
  conversationId: string;
};

export type AIBranchRequest = {
  type: "branch";
  messageId: string;
  content: string;
  conversationId: string;
};

export type AIEditRequest = {
  type: "edit";
  messageId: string;
  content: string;
  conversationId: string;
};

export type AIClientMessage =
  | AIMessageRequest
  | AICancelRequest
  | AIBranchRequest
  | AIEditRequest;

/* ─── Wire protocol: Server → Client ─── */

export type AIChunkMessage = {
  type: "chunk";
  content: string;
  messageId: string;
  conversationId: string;
};

export type AIThinkingMessage = {
  type: "thinking";
  content: string;
  messageId: string;
  conversationId: string;
};

export type AIToolStatusMessage = {
  type: "tool_status";
  name: string;
  status: "running" | "complete";
  input?: unknown;
  result?: string;
  messageId: string;
  conversationId: string;
};

export type AICompleteMessage = {
  type: "complete";
  durationMs?: number;
  messageId: string;
  model?: string;
  conversationId: string;
  usage?: AIUsage;
  sources?: RAGSource[];
};

export type StreamAICompleteMetadata = {
  sources?: RAGSource[];
};

export type AIStreamFinishReason =
  | "complete"
  | "max_tokens"
  | "max_total_tokens"
  | "max_duration"
  | "max_turns"
  | "aborted"
  | "error";

export type AIStreamFinish = {
  durationMs: number;
  fullResponse: string;
  reason: AIStreamFinishReason;
  turns: number;
  /** Aggregate normalized usage across every provider turn. */
  usage: AIUsage;
};

/* ─── Structured SSE events (streamAIToSSE `structuredEvents: true`) ───
 *
 * With `structuredEvents` enabled, every SSE frame's `data` is JSON (parse it)
 * rather than pre-rendered HTML, and the overloaded `status` terminal splits
 * into three distinct event names: `complete`, `stopped`, and `error`. The
 * delta events keep their names (`content`/`thinking`/`tools`/`images`/`ping`)
 * but carry the typed payloads below. */

/** Why an agentic SSE run stopped short of a normal completion.
 *  Note: `max_duration_ms` here differs from `AIStreamFinishReason.max_duration`
 *  (the `onFinish` vocabulary) — the SSE reason is intentionally suffixed. */
export type AIStreamStopReason =
  | "max_total_tokens"
  | "max_duration_ms"
  | "max_tokens"
  | "max_turns"
  | "aborted";

/** `event: "content"` — an assistant text delta. */
export type AISSEContentPayload = {
  /** Just this chunk's text. */
  delta: string;
  /** The full assistant text accumulated so far (including `delta`). */
  full: string;
};

/** `event: "thinking"` — accumulated reasoning text so far. */
export type AISSEThinkingPayload = {
  text: string;
};

/** `event: "tools"` — a single tool transition (one `running`, then one
 *  `complete` per call), unlike the legacy accumulated-HTML blob. */
export type AISSEToolPayload = {
  name: string;
  status: "running" | "complete";
  input: unknown;
  /** Present only on `status: "complete"`. */
  result?: string;
};

/** `event: "images"` — a generated image. */
export type AISSEImagePayload = {
  data: string;
  format: string;
  revisedPrompt?: string;
};

/** `event: "complete"` — a normal terminal completion. */
export type AISSECompletePayload = {
  usage?: AIUsage;
  durationMs: number;
  model: string;
};

/** `event: "stopped"` — a ceiling/limit/abort terminal (not an error). */
export type AISSEStoppedPayload = {
  reason: AIStreamStopReason;
  /** Human-readable explanation (e.g. "Stopped: token budget reached …"). */
  detail: string;
};

/** `event: "error"` — a genuine terminal error (thrown / not found). */
export type AISSEErrorPayload = {
  message: string;
};

export type AIImageMessage = {
  type: "image";
  data: string;
  format: string;
  isPartial: boolean;
  revisedPrompt?: string;
  imageId?: string;
  messageId: string;
  conversationId: string;
};

export type AIErrorMessage = {
  type: "error";
  message: string;
  messageId?: string;
  conversationId?: string;
};

export type AIRetrievingMessage = {
  type: "rag_retrieving";
  conversationId: string;
  messageId: string;
  retrievalStartedAt: number;
};

export type AIRetrievedMessage = {
  type: "rag_retrieved";
  conversationId: string;
  messageId: string;
  retrievalStartedAt?: number;
  retrievedAt: number;
  retrievalDurationMs?: number;
  sources: RAGSource[];
  trace?: RAGRetrievalTrace;
};

export type AITurnQueuedMessage = {
  type: "turn_queued";
  conversationId: string;
  messageId: string;
  position: number;
};

export type AITurnStartedMessage = {
  type: "turn_started";
  conversationId: string;
  messageId: string;
};

export type AIBranchedMessage = {
  type: "branched";
  attachments?: AIAttachment[];
  content: string;
  fromMessageId: string;
  messageId: string;
  newConversationId: string;
  oldConversationId: string;
  mode?: "append" | "replace";
};

export type AIServerMessage =
  | AIChunkMessage
  | AIThinkingMessage
  | AIToolStatusMessage
  | AIImageMessage
  | AICompleteMessage
  | AIRetrievingMessage
  | AIRetrievedMessage
  | AITurnQueuedMessage
  | AITurnStartedMessage
  | AIBranchedMessage
  | AIErrorMessage;

/* ─── Conversation state ─── */

export type AIRole = "user" | "assistant" | "system";

export type AIToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: string;
};

export type AIImageData = {
  data: string;
  format: string;
  isPartial: boolean;
  revisedPrompt?: string;
  imageId?: string;
};

export type AIMessage = {
  id: string;
  role: AIRole;
  content: string;
  conversationId: string;
  parentId?: string;
  attachments?: AIAttachment[];
  thinking?: string;
  toolCalls?: AIToolCall[];
  images?: AIImageData[];
  isQueued?: boolean;
  isStreaming?: boolean;
  model?: string;
  usage?: AIUsage;
  sources?: RAGSource[];
  retrievalStartedAt?: number;
  retrievedAt?: number;
  retrievalDurationMs?: number;
  retrievalTrace?: RAGRetrievalTrace;
  durationMs?: number;
  timestamp: number;
};

export type AIConversation = {
  id: string;
  title?: string;
  messages: AIMessage[];
  activeStreamAbort?: AbortController;
  createdAt: number;
  lastMessageAt?: number;
};

export type AIConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  lastMessageAt?: number;
};

/* ─── Configuration ─── */

export type StreamAIOptions = {
  provider: AIProviderConfig;
  model: string;
  messages?: AIProviderMessage[];
  systemPrompt?: string;
  /** Cache the system prompt (Anthropic prompt caching). See AIProviderStreamParams. */
  cacheSystemPrompt?: boolean;
  /** Per-call override of the provider `promptCaching` default. See AIProviderStreamParams. */
  promptCaching?: boolean;
  tools?: AIToolMap;
  /** Portable reasoning effort — translated per provider/model. */
  reasoning?: ReasoningConfig;
  onChunk?: (chunk: AITextChunk) => AITextChunk | void;
  onComplete?: (
    fullResponse: string,
    usage?: AIUsage,
    metadata?: StreamAICompleteMetadata,
  ) => void;
  onToolUse?: (name: string, input: unknown, result: string) => void;
  onImage?: (imageData: AIImageData) => void;
  /** Invoked once per completed turn with that turn's normalized usage —
   *  surfaces per-turn spend (incl. cache reads) for logging/budgets.
   *  `turnText` is the assistant text emitted DURING that turn (may be "").
   *  It fires before the turn's tools execute, so interleaving callbacks in
   *  order — onTurn(0) → onToolUse… → onTurn(1) → … — reconstructs the live
   *  transcript exactly (each turn's text, then that turn's tool calls). */
  onTurn?: (turn: number, usage?: AIUsage, turnText?: string) => void;
  /** Guaranteed exactly once when the agent loop terminates, including budget
   *  stops, aborts, and errors. Unlike `onComplete`, this reports aggregate
   *  usage across every turn and may be async for durable metering. */
  onFinish?: (finish: AIStreamFinish) => void | Promise<void>;
  maxTokens?: number;
  maxTurns?: number;
  /** Cumulative input+output token ceiling across all turns. When reached, the
   *  loop aborts with a `status` event. Unset = no token ceiling. */
  maxTotalTokens?: number;
  /** Wall-clock ceiling in ms across all turns. When reached, the loop aborts
   *  with a `status` event. Unset = no time ceiling. */
  maxDurationMs?: number;
  /** Cap on tool-result characters fed back into the message array. Larger
   *  results are truncated head+tail with a marker. Unset = no truncation. */
  maxToolResultChars?: number;
  /** Interval (ms) at which a `ping` keepalive event is emitted while the stream
   *  is silent — i.e. during tool execution or while waiting on the next turn's
   *  first token. Agentic turns routinely go silent for seconds (a large tool
   *  result inflates the prompt and pushes time-to-first-token up), and any
   *  intermediary with an idle timeout (a reverse proxy, or Bun.serve's own
   *  default) will reap a silent SSE socket, hanging the client with no error.
   *  Pings fire ONLY during silence (the timer resets on every real event) so
   *  they never interleave with live output. Default 15000; set 0 to disable. */
  heartbeatMs?: number;
  /** Switch the SSE stream from pre-rendered HTML in `data` to typed events
   *  with JSON payloads, for headless consumers that render their own UI.
   *  When enabled: every `data` is JSON (parse it), and the overloaded `status`
   *  terminal splits into distinct `complete` (`AISSECompletePayload`), `stopped`
   *  (`AISSEStoppedPayload`), and `error` (`AISSEErrorPayload`) events. Delta
   *  events keep their names but carry `AISSEContentPayload` / `AISSEThinkingPayload`
   *  / `AISSEToolPayload` / `AISSEImagePayload`; `ping` is unchanged. Default off
   *  keeps the HTML renderers (built-in HTMX/default UI). */
  structuredEvents?: boolean;
  signal?: AbortSignal;
  completeMeta?: StreamAICompleteMetadata;
};

/* ─── Client-side state ─── */

export type AIStreamState = {
  conversations: Map<string, AIConversation>;
  activeConversationId: string | null;
  isStreaming: boolean;
  error: string | null;
};

export type AIStoreAction =
  | {
      type: "chunk";
      conversationId: string;
      messageId: string;
      content: string;
    }
  | {
      type: "thinking";
      conversationId: string;
      messageId: string;
      content: string;
    }
  | {
      type: "tool_status";
      conversationId: string;
      messageId: string;
      name: string;
      status: "running" | "complete";
      input?: unknown;
      result?: string;
    }
  | {
      type: "complete";
      conversationId: string;
      durationMs?: number;
      messageId: string;
      model?: string;
      usage?: AIUsage;
      sources?: RAGSource[];
    }
  | {
      type: "image";
      conversationId: string;
      messageId: string;
      data: string;
      format: string;
      isPartial: boolean;
      revisedPrompt?: string;
      imageId?: string;
    }
  | { type: "error"; message: string }
  | {
      type: "rag_retrieving";
      conversationId: string;
      messageId: string;
      retrievalStartedAt: number;
    }
  | {
      type: "rag_retrieved";
      conversationId: string;
      messageId: string;
      retrievalStartedAt?: number;
      retrievedAt: number;
      retrievalDurationMs?: number;
      sources: RAGSource[];
      trace?: RAGRetrievalTrace;
    }
  | {
      type: "send";
      content: string;
      conversationId: string;
      messageId: string;
      attachments?: AIAttachment[];
    }
  | {
      type: "turn_queued";
      conversationId: string;
      messageId: string;
      position: number;
    }
  | {
      type: "turn_started";
      conversationId: string;
      messageId: string;
    }
  | { type: "cancel" }
  | {
      type: "branch";
      attachments?: AIAttachment[];
      content: string;
      oldConversationId: string;
      newConversationId: string;
      fromMessageId: string;
      messageId: string;
      mode?: "append" | "replace";
    }
  | { type: "set_conversation"; conversationId: string };

/* ─── WebSocket interface ─── */

export type AIWebSocket = {
  send(data: string): void;
  readyState: number;
};

/* ─── Conversation store ─── */

export type AIConversationStore = SessionStore<
  AIConversation,
  AIConversationSummary
>;

/* ─── HTMX render config ─── */

export type AIHTMXRenderConfig = {
  messageStart?: (input: {
    conversationId: string;
    messageId: string;
    content: string;
    sseUrl: string;
    cancelUrl: string;
  }) => string;
  chunk?: (text: string, fullContent: string) => string;
  thinking?: (text: string) => string;
  toolRunning?: (name: string, input: unknown) => string;
  toolComplete?: (name: string, result: string) => string;
  image?: (data: string, format: string, revisedPrompt?: string) => string;
  ragRetrieving?: (input?: {
    conversationId: string;
    messageId: string;
    retrievalStartedAt?: number;
  }) => string;
  complete?: (usage?: AIUsage, durationMs?: number, model?: string) => string;
  ragRetrieved?: (
    sources: RAGSource[],
    input?: {
      conversationId: string;
      messageId: string;
      retrievalStartedAt?: number;
      retrievedAt?: number;
      retrievalDurationMs?: number;
      trace?: RAGRetrievalTrace;
    },
  ) => string;
  canceled?: () => string;
  error?: (message: string) => string;
};

export type AIChatPluginConfig = {
  path?: string;
  provider: (providerName: string) => AIProviderConfig;
  model?: string | ((providerName: string) => string);
  tools?:
    | AIToolMap
    | ((providerName: string, model: string) => AIToolMap | undefined);
  /** Portable reasoning effort — translated per provider/model. */
  reasoning?:
    | ReasoningConfig
    | ((providerName: string, model: string) => ReasoningConfig | undefined);
  systemPrompt?: string;
  maxTurns?: number;
  parseProvider?: (content: string) => {
    content: string;
    model?: string;
    providerName: string;
  };
  onComplete?: (
    conversationId: string,
    fullResponse: string,
    usage?: AIUsage,
  ) => void;
  store?: AIConversationStore;
  htmx?:
    | boolean
    | {
        render?: AIHTMXRenderConfig;
      };
};

export type AIConnectionOptions = {
  protocols?: string[];
  reconnect?: boolean;
  pingInterval?: number;
  maxReconnectAttempts?: number;
};
