import type {
  AIProviderConfig,
  AIProviderStreamParams,
} from "../../../types/ai";
import { openai } from "./openai";
import { openaiResponses } from "./openaiResponses";

export type OpenRouterDataCollection = "allow" | "deny";
export type OpenRouterQuantization =
  | "bf16"
  | "fp4"
  | "fp6"
  | "fp8"
  | "fp16"
  | "fp32"
  | "int4"
  | "int8"
  | "unknown";
export type OpenRouterSortStrategy = "latency" | "price" | "throughput";
export type OpenRouterSort =
  | OpenRouterSortStrategy
  | {
      by: OpenRouterSortStrategy;
      partition?: "model" | "none";
    };
export type OpenRouterPerformancePreference =
  | number
  | {
      p50?: number;
      p75?: number;
      p90?: number;
      p99?: number;
    };
export type OpenRouterMaxPrice = {
  /** Maximum completion-token price in USD per million tokens. */
  completion?: number;
  /** Maximum price in USD per image. */
  image?: number;
  /** Maximum prompt-token price in USD per million tokens. */
  prompt?: number;
  /** Maximum price in USD per request. */
  request?: number;
};

export type OpenRouterProviderRouting = {
  allowFallbacks?: boolean;
  dataCollection?: OpenRouterDataCollection;
  enforceDistillableText?: boolean;
  ignore?: readonly string[];
  maxPrice?: OpenRouterMaxPrice;
  only?: readonly string[];
  order?: readonly string[];
  preferredMaxLatency?: OpenRouterPerformancePreference;
  preferredMinThroughput?: OpenRouterPerformancePreference;
  quantizations?: readonly OpenRouterQuantization[];
  requireParameters?: boolean;
  sort?: OpenRouterSort;
  zdr?: boolean;
};

export type OpenRouterServiceTier =
  | "auto"
  | "default"
  | "flex"
  | "priority"
  | "fast";

export type OpenRouterResponseCache = {
  clear?: boolean;
  enabled: boolean;
  /** OpenRouter response-cache TTL in seconds (1-86400). */
  ttlSeconds?: number;
};

export type OpenRouterCacheControl = {
  type: "ephemeral";
  ttl?: "5m" | "1h";
};

export type OpenRouterPromptCacheOptions = {
  mode: "explicit";
  ttl?: string;
};

export type OpenRouterReasoning = {
  context?: "all_turns" | "auto" | "current_turn";
  effort?: "minimal" | "low" | "medium" | "high" | "max" | "xhigh";
  enabled?: boolean;
  exclude?: boolean;
  maxTokens?: number;
  mode?: "pro";
  summary?: "auto" | "concise" | "detailed";
};

export type OpenRouterPlugin = {
  id: string;
  [option: string]: unknown;
};

export type OpenRouterServerTool = {
  type:
    | "openrouter:web_search"
    | "openrouter:web_fetch"
    | "openrouter:datetime"
    | "openrouter:image_generation"
    | "openrouter:apply_patch"
    | "openrouter:shell"
    | "openrouter:fusion"
    | "openrouter:advisor"
    | "openrouter:subagent"
    | "openrouter:experimental__search_models";
  parameters?: Record<string, unknown>;
};

export type OpenRouterRequestOptions = {
  /** Automatic top-level prompt caching, including optional Anthropic TTL. */
  cacheControl?: OpenRouterCacheControl;
  /** Future OpenRouter fields. Security-sensitive routing fields are rejected. */
  extraBody?: Record<string, unknown>;
  fallbackModels?: readonly string[];
  includeReasoning?: boolean;
  maxToolCalls?: number;
  plugins?: readonly OpenRouterPlugin[];
  /** Stable cache identity used by compatible OpenAI-family models. */
  promptCacheKey?: string;
  /** OpenAI explicit-cache mode and TTL. */
  promptCacheOptions?: OpenRouterPromptCacheOptions;
  preset?: string;
  responseCache?: OpenRouterResponseCache;
  /** OpenRouter-native reasoning controls beyond the portable effort knob. */
  reasoning?: OpenRouterReasoning;
  routerMetadata?: boolean;
  routing?: OpenRouterProviderRouting;
  serverTools?: readonly OpenRouterServerTool[];
  serviceTier?: OpenRouterServiceTier;
  sessionId?: string;
  stopServerToolsWhen?: readonly Record<string, unknown>[];
  transforms?: readonly string[];
  user?: string;
  verbosity?: "low" | "medium" | "high";
};

export type OpenRouterConfig = {
  /**
   * Local model policy. Entries are exact model IDs or namespace wildcards such
   * as `anthropic/*`. Requests outside the list fail before network access.
   */
  allowedModels?: readonly string[];
  /** Preset slugs deliberately approved for use with this provider. */
  allowedPresets?: readonly string[];
  /**
   * Inference-provider policy sent as OpenRouter's `provider.only`. When
   * `routing.only` is also set, every entry must be allowed by this policy.
   */
  allowedProviders?: readonly string[];
  apiKey?: string;
  /** Up to two OpenRouter marketplace categories. */
  appCategories?: readonly string[];
  /** Public application name used for optional OpenRouter attribution. */
  appName?: string;
  /** Public application URL used for optional OpenRouter attribution. */
  appUrl?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Default OpenRouter request options, overridable per call. */
  requestOptions?: OpenRouterRequestOptions;
  routing?: OpenRouterProviderRouting;
  tokenSource?: () => Promise<string> | string;
};

const DEFAULT_BASE_URL = "https://openrouter.ai/api";
const MAX_APP_CATEGORIES = 2;

const withoutLatestPrefix = (model: string) =>
  model.startsWith("~") ? model.slice(1) : model;

const modelForOpenAICapabilities = (model: string) => {
  const normalized = withoutLatestPrefix(model);
  return normalized.startsWith("openai/")
    ? normalized.slice("openai/".length)
    : normalized;
};

const modelMatchesRule = (model: string, rule: string) => {
  const normalizedModel = withoutLatestPrefix(model);
  const normalizedRule = withoutLatestPrefix(rule);
  if (normalizedRule.endsWith("/*")) {
    return normalizedModel.startsWith(normalizedRule.slice(0, -1));
  }

  return normalizedModel === normalizedRule;
};

const providerMatchesRule = (provider: string, rule: string) =>
  provider === rule || provider.startsWith(`${rule}/`);

const assertNonEmptyPolicy = (
  label: string,
  value: readonly string[] | undefined,
) => {
  if (value && value.length === 0) {
    throw new Error(`openrouter() ${label} must not be empty`);
  }
};

const assertRoutingPolicy = (config: OpenRouterConfig) => {
  assertNonEmptyPolicy("allowedProviders", config.allowedProviders);
  assertNonEmptyPolicy("routing.only", config.routing?.only);
  assertNonEmptyPolicy("allowedPresets", config.allowedPresets);
  if (
    config.appCategories &&
    config.appCategories.length > MAX_APP_CATEGORIES
  ) {
    throw new Error("openrouter() appCategories supports at most 2 entries");
  }
  if (!config.allowedProviders) return;
  const selected = [
    ...(config.routing?.only ?? []),
    ...(config.routing?.order ?? []),
  ];
  const denied = selected.find(
    (provider) =>
      !config.allowedProviders!.some((rule) =>
        providerMatchesRule(provider, rule),
      ),
  );
  if (denied) {
    throw new Error(
      `openrouter() provider "${denied}" is outside allowedProviders`,
    );
  }
};

const assertRequestRoutingPolicy = (
  routing: OpenRouterProviderRouting | undefined,
  allowedProviders: readonly string[] | undefined,
) => {
  assertRoutingPolicy({
    allowedProviders,
    apiKey: "policy-validation",
    routing,
  });
};

const mapRouting = (
  routing: OpenRouterProviderRouting | undefined,
  allowedProviders: readonly string[] | undefined,
) => {
  const only = routing?.only ?? allowedProviders;
  const wire: Record<string, unknown> = {};
  if (typeof routing?.allowFallbacks === "boolean")
    wire.allow_fallbacks = routing.allowFallbacks;
  if (routing?.dataCollection) wire.data_collection = routing.dataCollection;
  if (typeof routing?.enforceDistillableText === "boolean")
    wire.enforce_distillable_text = routing.enforceDistillableText;
  if (routing?.ignore) wire.ignore = [...routing.ignore];
  if (routing?.maxPrice) wire.max_price = { ...routing.maxPrice };
  if (only) wire.only = [...only];
  if (routing?.order) wire.order = [...routing.order];
  if (routing?.preferredMaxLatency !== undefined)
    wire.preferred_max_latency = routing.preferredMaxLatency;
  if (routing?.preferredMinThroughput !== undefined)
    wire.preferred_min_throughput = routing.preferredMinThroughput;
  if (routing?.quantizations) wire.quantizations = [...routing.quantizations];
  if (typeof routing?.requireParameters === "boolean")
    wire.require_parameters = routing.requireParameters;
  if (routing?.sort) wire.sort = routing.sort;
  if (typeof routing?.zdr === "boolean") wire.zdr = routing.zdr;

  return wire;
};

const requestOptionsFor = (
  params: AIProviderStreamParams,
  defaults: OpenRouterRequestOptions | undefined,
) => {
  const supplied = params.providerOptions?.openrouter;
  if (supplied !== undefined && (typeof supplied !== "object" || !supplied)) {
    throw new Error("providerOptions.openrouter must be an object");
  }

  return {
    ...defaults,
    ...(supplied as OpenRouterRequestOptions | undefined),
  };
};

const resolveAttributionHeaders = async (
  config: OpenRouterConfig,
  params: AIProviderStreamParams,
) => {
  const supplied =
    typeof config.headers === "function"
      ? await config.headers()
      : (config.headers ?? {});
  const headers = new Headers(supplied);
  if (config.appUrl) headers.set("HTTP-Referer", config.appUrl);
  if (config.appName) headers.set("X-OpenRouter-Title", config.appName);
  if (config.appCategories?.length) {
    headers.set("X-OpenRouter-Categories", config.appCategories.join(","));
  }
  const options = requestOptionsFor(params, config.requestOptions);
  if (options.routerMetadata ?? true)
    headers.set("X-OpenRouter-Metadata", "enabled");
  if (options.sessionId) headers.set("X-Session-Id", options.sessionId);
  if (options.responseCache) {
    headers.set(
      "X-OpenRouter-Cache",
      options.responseCache.enabled ? "true" : "false",
    );
    if (options.responseCache.ttlSeconds !== undefined)
      headers.set(
        "X-OpenRouter-Cache-TTL",
        String(options.responseCache.ttlSeconds),
      );
    if (options.responseCache.clear)
      headers.set("X-OpenRouter-Cache-Clear", "true");
  }

  return headers;
};

const SECURITY_SENSITIVE_EXTRA_BODY_FIELDS = new Set([
  "messages",
  "model",
  "models",
  "plugins",
  "preset",
  "provider",
  "stream",
  "tools",
]);

const assertAllowedPreset = (
  preset: string | undefined,
  allowedPresets: readonly string[] | undefined,
) => {
  if (!preset) return;
  if (allowedPresets?.includes(preset)) return;
  throw new Error(`OpenRouter preset "${preset}" is not allowed`);
};

const assertIndirectModels = (
  value: unknown,
  allowedModels: readonly string[] | undefined,
  key = "",
) => {
  if (key === "model" && typeof value === "string")
    assertAllowedModel(value, allowedModels);
  if (key === "models" && Array.isArray(value)) {
    for (const model of value) {
      if (typeof model === "string") assertAllowedModel(model, allowedModels);
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) assertIndirectModels(item, allowedModels);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value))
      assertIndirectModels(child, allowedModels, childKey);
  }
};

const assertRequestOptions = (
  options: OpenRouterRequestOptions,
  allowedModels: readonly string[] | undefined,
  allowedPresets: readonly string[] | undefined,
  allowedProviders: readonly string[] | undefined,
) => {
  assertAllowedPreset(options.preset, allowedPresets);
  assertRequestRoutingPolicy(options.routing, allowedProviders);
  if (options.sessionId && options.sessionId.length > 256)
    throw new Error("OpenRouter sessionId must be at most 256 characters");
  const ttl = options.responseCache?.ttlSeconds;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400))
    throw new Error("OpenRouter response-cache TTL must be 1-86400 seconds");
  if (options.responseCache?.clear && !options.responseCache.enabled)
    throw new Error("OpenRouter cache clear requires response caching enabled");
  if (options.fallbackModels) {
    if (options.fallbackModels.length === 0)
      throw new Error("OpenRouter fallbackModels must not be empty");
    for (const model of options.fallbackModels)
      assertAllowedModel(model, allowedModels);
  }
  assertIndirectModels(options.serverTools, allowedModels);
  assertIndirectModels(options.plugins, allowedModels);
  if (options.extraBody) {
    const unsafe = Object.keys(options.extraBody).find((key) =>
      SECURITY_SENSITIVE_EXTRA_BODY_FIELDS.has(key),
    );
    if (unsafe)
      throw new Error(`OpenRouter extraBody cannot override "${unsafe}"`);
  }
};

const assertAllowedModel = (
  model: string,
  allowedModels: readonly string[] | undefined,
) => {
  if (!allowedModels) return;
  if (allowedModels.some((rule) => modelMatchesRule(model, rule))) return;
  throw new Error(`OpenRouter model "${model}" is not allowed`);
};

const snapshotPolicy = (config: OpenRouterConfig) => ({
  allowedModels: config.allowedModels ? [...config.allowedModels] : undefined,
  allowedPresets: config.allowedPresets
    ? [...config.allowedPresets]
    : undefined,
});

const transformOpenRouterRequest = (
  config: OpenRouterConfig,
  allowedModels: readonly string[] | undefined,
  allowedPresets: readonly string[] | undefined,
  body: Record<string, unknown>,
  params: AIProviderStreamParams,
) => {
  const options = requestOptionsFor(params, config.requestOptions);
  assertRequestOptions(
    options,
    allowedModels,
    allowedPresets,
    config.allowedProviders,
  );
  const transformed = { ...body, ...options.extraBody };
  const requestedReasoning: Record<string, unknown> = {};
  if (params.reasoning?.budgetTokens !== undefined) {
    requestedReasoning.max_tokens = params.reasoning.budgetTokens;
    delete transformed.reasoning_effort;
  } else if (params.reasoning?.effort) {
    requestedReasoning.effort = params.reasoning.effort;
    delete transformed.reasoning_effort;
  }
  if (options.reasoning) {
    Object.assign(requestedReasoning, options.reasoning);
    if (options.reasoning.maxTokens !== undefined) {
      requestedReasoning.max_tokens = options.reasoning.maxTokens;
      delete requestedReasoning.maxTokens;
    }
  }
  if (Object.keys(requestedReasoning).length > 0)
    transformed.reasoning = requestedReasoning;
  const automaticCacheControl =
    params.promptCaching === true || params.cacheSystemPrompt === true
      ? ({ type: "ephemeral" } satisfies OpenRouterCacheControl)
      : undefined;
  const cacheControl = options.cacheControl ?? automaticCacheControl;
  if (cacheControl) transformed.cache_control = cacheControl;
  if (options.promptCacheKey)
    transformed.prompt_cache_key = options.promptCacheKey;
  if (options.promptCacheOptions)
    transformed.prompt_cache_options = options.promptCacheOptions;
  const routing = mapRouting(
    { ...config.routing, ...options.routing },
    config.allowedProviders,
  );
  if (Object.keys(routing).length > 0) transformed.provider = routing;
  if (options.fallbackModels) transformed.models = [...options.fallbackModels];
  if (options.includeReasoning !== undefined)
    transformed.include_reasoning = options.includeReasoning;
  if (options.maxToolCalls !== undefined)
    transformed.max_tool_calls = options.maxToolCalls;
  if (options.plugins) transformed.plugins = [...options.plugins];
  if (options.preset) transformed.preset = options.preset;
  if (options.serverTools) {
    transformed.tools = [
      ...(Array.isArray(transformed.tools) ? transformed.tools : []),
      ...options.serverTools,
    ];
  }
  if (options.serviceTier) transformed.service_tier = options.serviceTier;
  if (options.sessionId) transformed.session_id = options.sessionId;
  if (options.stopServerToolsWhen)
    transformed.stop_server_tools_when = options.stopServerToolsWhen;
  if (options.transforms) transformed.transforms = [...options.transforms];
  if (options.user) transformed.user = options.user;
  if (options.verbosity) transformed.verbosity = options.verbosity;

  return transformed;
};

const withOpenRouterPolicy = (
  provider: AIProviderConfig,
  allowedModels: readonly string[] | undefined,
  allowedPresets: readonly string[] | undefined,
): AIProviderConfig => ({
  stream: (params) => {
    if (params.model.startsWith("@preset/")) {
      assertAllowedPreset(
        params.model.slice("@preset/".length),
        allowedPresets,
      );
    } else {
      const presetSeparator = params.model.indexOf("@preset/");
      if (presetSeparator >= 0) {
        assertAllowedModel(
          params.model.slice(0, presetSeparator),
          allowedModels,
        );
        assertAllowedPreset(
          params.model.slice(presetSeparator + "@preset/".length),
          allowedPresets,
        );
      } else {
        assertAllowedModel(params.model, allowedModels);
      }
    }
    return provider.stream(params);
  },
});

/**
 * OpenRouter provider for the shared AbsoluteJS AI contract.
 *
 * Uses the existing OpenAI-compatible streaming implementation while adding
 * OpenRouter attribution, typed provider routing, local model policy, provider
 * allowlists, cost metadata, and OpenRouter-specific error attribution.
 */
export const openrouter = (config: OpenRouterConfig): AIProviderConfig => {
  assertRoutingPolicy(config);
  // Snapshot policy at construction so later mutation of a caller-owned array
  // cannot silently broaden a long-lived provider instance.
  const { allowedModels, allowedPresets } = snapshotPolicy(config);
  const provider = openai({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    fetch: config.fetch,
    headers: (params) => resolveAttributionHeaders(config, params),
    modelForCapabilities: modelForOpenAICapabilities,
    providerName: "openrouter",
    tokenSource: config.tokenSource,
    transformRequestBody: (body, params) =>
      transformOpenRouterRequest(
        config,
        allowedModels,
        allowedPresets,
        body,
        params,
      ),
  });
  return withOpenRouterPolicy(provider, allowedModels, allowedPresets);
};

/** OpenRouter's stateless OpenAI-compatible Responses API provider skin. */
export const openrouterResponses = (
  config: OpenRouterConfig,
): AIProviderConfig => {
  assertRoutingPolicy(config);
  const { allowedModels, allowedPresets } = snapshotPolicy(config);
  const provider = openaiResponses({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    fetch: config.fetch,
    headers: (params) => resolveAttributionHeaders(config, params),
    modelForCapabilities: modelForOpenAICapabilities,
    providerName: "openrouter",
    tokenSource: config.tokenSource,
    transformRequestBody: (body, params) =>
      transformOpenRouterRequest(
        config,
        allowedModels,
        allowedPresets,
        body,
        params,
      ),
  });
  return withOpenRouterPolicy(provider, allowedModels, allowedPresets);
};

export {
  createOpenRouterClient,
  openRouterModelMatchesRule,
} from "./openrouterClient";
export type {
  OpenRouterClient,
  OpenRouterClientConfig,
  OpenRouterEmbeddingRequest,
  OpenRouterEmbeddingResponse,
  OpenRouterHttpRequestOptions,
  OpenRouterImageRequest,
  OpenRouterImageResponse,
  OpenRouterModel,
  OpenRouterModelList,
  OpenRouterRerankRequest,
  OpenRouterRerankResponse,
  OpenRouterResponsesRequest,
  OpenRouterSpeechRequest,
  OpenRouterTranscriptionRequest,
  OpenRouterVideoRequest,
} from "./openrouterClient";
