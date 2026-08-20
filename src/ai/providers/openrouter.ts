import type {
  AIProviderConfig,
  AIProviderStreamParams,
} from "../../../types/ai";
import { openai } from "./openai";

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

export type OpenRouterConfig = {
  /**
   * Local model policy. Entries are exact model IDs or namespace wildcards such
   * as `anthropic/*`. Requests outside the list fail before network access.
   */
  allowedModels?: readonly string[];
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

const resolveAttributionHeaders = async (config: OpenRouterConfig) => {
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

  return headers;
};

const assertAllowedModel = (
  model: string,
  allowedModels: readonly string[] | undefined,
) => {
  if (!allowedModels) return;
  if (allowedModels.some((rule) => modelMatchesRule(model, rule))) return;
  throw new Error(`OpenRouter model "${model}" is not allowed`);
};

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
  const allowedModels = config.allowedModels
    ? [...config.allowedModels]
    : undefined;
  const routing = mapRouting(config.routing, config.allowedProviders);
  const provider = openai({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    fetch: config.fetch,
    headers: () => resolveAttributionHeaders(config),
    modelForCapabilities: modelForOpenAICapabilities,
    providerName: "openrouter",
    tokenSource: config.tokenSource,
    transformRequestBody: (body, params) => {
      const transformed = { ...body };
      // OpenRouter normalizes reasoning across model vendors. Prefer an
      // explicit token budget over effort when both portable fields are set,
      // matching the rest of the AbsoluteJS provider contract.
      if (params.reasoning?.budgetTokens !== undefined) {
        transformed.reasoning = {
          max_tokens: params.reasoning.budgetTokens,
        };
        delete transformed.reasoning_effort;
      } else if (params.reasoning?.effort) {
        transformed.reasoning = { effort: params.reasoning.effort };
        delete transformed.reasoning_effort;
      }
      if (Object.keys(routing).length > 0) transformed.provider = routing;

      return transformed;
    },
  });

  return {
    stream: (params: AIProviderStreamParams) => {
      assertAllowedModel(params.model, allowedModels);

      return provider.stream(params);
    },
  };
};
