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

export type AIToolDefinition = {
  description: string;
  input: Record<string, unknown>;
  handler: (input: unknown) => Promise<string> | string;
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

export type AIClientMessage =
  | AIMessageRequest
  | AICancelRequest
  | AIBranchRequest;

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

export type AIServerMessage =
  | AIChunkMessage
  | AIThinkingMessage
  | AIToolStatusMessage
  | AIImageMessage
  | AICompleteMessage
  | AIRetrievingMessage
  | AIRetrievedMessage
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
  maxTokens?: number;
  maxTurns?: number;
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
  | { type: "cancel" }
  | {
      type: "branch";
      oldConversationId: string;
      newConversationId: string;
      fromMessageId: string;
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
    | ((
        providerName: string,
        model: string,
      ) => ReasoningConfig | undefined);
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
