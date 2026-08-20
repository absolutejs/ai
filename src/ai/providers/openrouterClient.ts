import { ProviderError } from "../errors/providerError";

export type OpenRouterClientConfig = {
  allowedModels?: readonly string[];
  apiKey?: string;
  batchBaseUrl?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  tokenSource?: () => Promise<string> | string;
};

export type OpenRouterPKCE = {
  codeChallenge: string;
  codeChallengeMethod: "S256";
  codeVerifier: string;
};

export type OpenRouterAuthorizationUrlOptions = {
  baseUrl?: string;
  callbackUrl?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  keyLabel?: string;
};

export type OpenRouterAuthCodeExchangeRequest = {
  code: string;
  code_challenge_method?: "S256" | "plain";
  code_verifier?: string;
};

export type OpenRouterAuthCodeExchangeResponse = {
  key: string;
  user_id: string | null;
};

export type OpenRouterCreateAuthCodeRequest = {
  callback_url: string;
  code_challenge?: string;
  code_challenge_method?: "S256" | "plain";
  expires_at?: string;
  key_label?: string;
  limit?: number;
  usage_limit_type?: string;
  workspace_id?: string;
};

export type OpenRouterCreateAuthCodeResponse = {
  data: { app_id: number; created_at: string; id: string };
};

export type OpenRouterBatchEndpoint =
  | "/v1/chat/completions"
  | "/v1/responses"
  | "/v1/messages"
  | "/v1/embeddings";

export type OpenRouterBatchStatus =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

export type OpenRouterBatchRequest = {
  custom_id: string;
  body: Record<string, unknown>;
};

export type OpenRouterBatchResult = {
  custom_id: string;
  id: string;
  response?: {
    body: Record<string, unknown>;
    request_id: string;
    status_code: number;
  };
  error?: Record<string, unknown>;
};

export type OpenRouterBatch = {
  id: string;
  endpoint: OpenRouterBatchEndpoint;
  model: string;
  status: OpenRouterBatchStatus;
  completion_window?: "24h";
  created_at?: string;
  completed_at?: string | null;
  request_counts?: { completed: number; failed: number; total: number };
  results?: OpenRouterBatchResult[];
  usage?: {
    completion_tokens: number;
    cost: number;
    is_byok: boolean;
    prompt_tokens: number;
    total_tokens: number;
  };
  [field: string]: unknown;
};

export type OpenRouterCreateBatchRequest = {
  endpoint: OpenRouterBatchEndpoint;
  model: string;
  requests: [OpenRouterBatchRequest, ...OpenRouterBatchRequest[]];
  completion_window?: "24h";
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: Record<string, unknown>;
  pricing?: OpenRouterPricing;
  supported_parameters?: string[] | Record<string, unknown>;
  [field: string]: unknown;
};

export type OpenRouterPricingKey =
  | "prompt"
  | "completion"
  | "request"
  | "image"
  | "web_search"
  | "internal_reasoning"
  | "input_cache_read"
  | "input_cache_write";

export type OpenRouterPricing = Partial<Record<OpenRouterPricingKey, string>> &
  Record<string, string | undefined>;

export type OpenRouterCostUnits = Partial<Record<OpenRouterPricingKey, number>>;

export type OpenRouterCostEstimate = {
  components: Partial<Record<OpenRouterPricingKey, number>>;
  total: number;
};

const OPENROUTER_PRICING_KEYS: readonly OpenRouterPricingKey[] = [
  "prompt",
  "completion",
  "request",
  "image",
  "web_search",
  "internal_reasoning",
  "input_cache_read",
  "input_cache_write",
];

/** Estimate USD cost using OpenRouter's per-unit model pricing fields. */
export const estimateOpenRouterCost = (
  pricing: OpenRouterPricing,
  units: OpenRouterCostUnits,
): OpenRouterCostEstimate => {
  const components: Partial<Record<OpenRouterPricingKey, number>> = {};
  let total = 0;
  for (const key of OPENROUTER_PRICING_KEYS) {
    const quantity = units[key];
    if (quantity === undefined) continue;
    if (!Number.isFinite(quantity) || quantity < 0)
      throw new Error(`OpenRouter ${key} units must be non-negative`);
    const rawPrice = pricing[key];
    if (rawPrice === undefined) continue;
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price < 0)
      throw new Error(`OpenRouter ${key} price must be non-negative`);
    components[key] = price * quantity;
    total += components[key];
  }
  return { components, total };
};

export const estimateOpenRouterModelCost = (
  model: Pick<OpenRouterModel, "pricing">,
  units: OpenRouterCostUnits,
) => estimateOpenRouterCost(model.pricing ?? {}, units);

export type OpenRouterModelList = { data: OpenRouterModel[] };

export type OpenRouterModelQuery = {
  arch?: string;
  context?: number;
  distillable?: "false" | "true";
  input_modalities?: string;
  max_price?: number;
  min_price?: number;
  model_authors?: string;
  output_modalities?: string;
  providers?: string;
  q?: string;
  region?: "eu";
  supported_parameters?: string;
  sort?:
    | "pricing-low-to-high"
    | "pricing-high-to-low"
    | "context-high-to-low"
    | "throughput-high-to-low"
    | "latency-low-to-high"
    | "most-popular"
    | "top-weekly"
    | "newest"
    | "intelligence-high-to-low"
    | "design-arena-elo-high-to-low";
  zdr?: "true";
};

export type OpenRouterEmbeddingRequest = {
  model: string;
  input: string | string[] | number[] | number[][];
  dimensions?: number;
  encoding_format?: "float" | "base64";
  provider?: Record<string, unknown>;
  user?: string;
};

export type OpenRouterEmbeddingResponse = {
  data: Array<{ embedding: number[] | string; index: number; object: string }>;
  model: string;
  object: string;
  usage?: { prompt_tokens: number; total_tokens: number; cost?: number };
};

export type OpenRouterRerankRequest = {
  model: string;
  query: string;
  documents: Array<string | { text: string }>;
  top_n?: number;
  return_documents?: boolean;
};

export type OpenRouterRerankResponse = {
  id?: string;
  model?: string;
  results: Array<{
    document?: { text: string };
    index: number;
    relevance_score: number;
  }>;
  usage?: Record<string, number>;
};

export type OpenRouterImageRequest = {
  model: string;
  prompt: string;
  n?: number;
  resolution?: string;
  aspect_ratio?: string;
  size?: string;
  quality?: "auto" | "low" | "medium" | "high";
  output_format?: "png" | "jpeg" | "webp" | "svg";
  background?: "auto" | "transparent" | "opaque";
  output_compression?: number;
  seed?: number;
  input_references?: Array<Record<string, unknown>>;
  provider?: Record<string, unknown>;
  stream?: boolean;
};

export type OpenRouterImageResponse = {
  created: number;
  data: Array<{ b64_json: string; media_type?: string }>;
  usage?: Record<string, number>;
};

export type OpenRouterImageModelEndpoint = {
  allowed_passthrough_parameters: string[];
  pricing: Array<{
    billable: string;
    cost_usd: number;
    unit: "image" | "megapixel" | "token" | string;
    variant?: string;
  }>;
  provider_name: string;
  provider_slug: string;
  provider_tag: string | null;
  supported_parameters: Record<string, unknown>;
  supports_streaming: boolean;
};

export type OpenRouterImageModelEndpoints = {
  endpoints: OpenRouterImageModelEndpoint[];
  id: string;
};

export type OpenRouterResponsesRequest = Record<string, unknown> & {
  input: unknown;
  model: string;
  stream?: boolean;
};

export type OpenRouterSpeechRequest = Record<string, unknown> & {
  input: string;
  model: string;
  voice: string;
};

export type OpenRouterTranscriptionRequest = Record<string, unknown> & {
  model: string;
};

export type OpenRouterVideoRequest = Record<string, unknown> & {
  model: string;
  prompt: string;
};

export type OpenRouterImageStreamEvent = Record<string, unknown> & {
  type: string;
  b64_json?: string;
  media_type?: string;
  partial_image_index?: number;
  usage?: Record<string, number>;
};

export type OpenRouterFile = {
  created_at: string;
  downloadable: boolean;
  filename: string;
  id: string;
  mime_type: string;
  size_bytes: number;
  type: "file";
};

export type OpenRouterFileList = {
  cursor: string | null;
  data: OpenRouterFile[];
  first_id: string | null;
  has_more: boolean;
  last_id: string | null;
};

export type OpenRouterVideoJob = {
  error?: string;
  generation_id?: string | null;
  id: string;
  polling_url?: string;
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  unsigned_urls?: string[];
  usage?: { cost?: number; is_byok?: boolean };
};

export type OpenRouterVideoWebhookEvent = {
  created_at: string;
  data: OpenRouterVideoJob & { model?: string | null };
  type:
    | "video.generation.completed"
    | "video.generation.failed"
    | "video.generation.cancelled"
    | "video.generation.expired";
};

export type OpenRouterZdrEndpoint = Record<string, unknown> & {
  context_length: number;
  model_id: string;
  model_name: string;
  name: string;
  pricing: Record<string, string>;
  provider_name: string;
  supported_parameters: string[];
  tag: string;
};

export type OpenRouterHttpRequestOptions = Omit<
  RequestInit,
  "body" | "headers"
> & {
  body?: unknown;
  headers?: HeadersInit;
  query?: Record<string, boolean | number | string | undefined>;
};

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_BATCH_BASE_URL = "https://openrouter.ai/api/beta";
const DEFAULT_SITE_URL = "https://openrouter.ai";
const TERMINAL_BATCH_STATUSES = new Set<OpenRouterBatchStatus>([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

const withoutLatestPrefix = (model: string) =>
  model.startsWith("~") ? model.slice(1) : model;

export const openRouterModelMatchesRule = (model: string, rule: string) => {
  const normalizedModel = withoutLatestPrefix(model);
  const normalizedRule = withoutLatestPrefix(rule);
  return normalizedRule.endsWith("/*")
    ? normalizedModel.startsWith(normalizedRule.slice(0, -1))
    : normalizedModel === normalizedRule;
};

const assertAllowedModel = (
  model: string,
  allowedModels: readonly string[] | undefined,
) => {
  if (!allowedModels) return;
  if (allowedModels.some((rule) => openRouterModelMatchesRule(model, rule)))
    return;
  throw new Error(`OpenRouter model "${model}" is not allowed`);
};

const normalizePath = (path: string) =>
  path.startsWith("/") ? path : `/${path}`;

const encodeModelPath = (model: string) =>
  model.split("/").map(encodeURIComponent).join("/");

const withQuery = (
  url: string,
  query: OpenRouterHttpRequestOptions["query"],
) => {
  if (!query) return url;
  const result = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) result.searchParams.set(key, String(value));
  }
  return result.toString();
};

const parseImageSSE = async function* (
  response: Response,
): AsyncGenerator<OpenRouterImageStreamEvent> {
  if (!response.body) throw new Error("OpenRouter image stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === "object" && "type" in parsed)
            yield parsed as OpenRouterImageStreamEvent;
        } catch {
          // Ignore malformed keepalive/event lines; a later valid event can continue.
        }
      }
      if (result.done) break;
    }
    if (buffer.startsWith("data: ")) {
      const parsed: unknown = JSON.parse(buffer.slice(6));
      if (parsed && typeof parsed === "object" && "type" in parsed)
        yield parsed as OpenRouterImageStreamEvent;
    }
  } finally {
    reader.releaseLock();
  }
};

const toBytes = (value: string | Uint8Array) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const generateOpenRouterPKCE = async (): Promise<OpenRouterPKCE> => {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = toBase64Url(random);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return {
    codeChallenge: toBase64Url(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
    codeVerifier,
  };
};

export const createOpenRouterAuthorizationUrl = (
  options: OpenRouterAuthorizationUrlOptions = {},
) => {
  const url = new URL("/auth", options.baseUrl ?? DEFAULT_SITE_URL);
  if (options.callbackUrl)
    url.searchParams.set("callback_url", options.callbackUrl);
  if (options.codeChallenge)
    url.searchParams.set("code_challenge", options.codeChallenge);
  if (options.codeChallengeMethod)
    url.searchParams.set("code_challenge_method", options.codeChallengeMethod);
  if (options.keyLabel) url.searchParams.set("key_label", options.keyLabel);
  return url.toString();
};

/** Exchange a single-use OAuth code. This endpoint intentionally has no API-key authentication. */
export const exchangeOpenRouterAuthCode = async (
  body: OpenRouterAuthCodeExchangeRequest,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<OpenRouterAuthCodeExchangeResponse> => {
  const response = await (options.fetch ?? globalThis.fetch)(
    `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/auth/keys`,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok)
    throw ProviderError.fromResponse(
      "openrouter",
      response.status,
      await response.text(),
    );
  return response.json() as Promise<OpenRouterAuthCodeExchangeResponse>;
};

export const createOpenRouterKeyLinks = async (
  key: string,
  siteUrl = DEFAULT_SITE_URL,
) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  const hash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const root = siteUrl.replace(/\/$/, "");
  return {
    hash,
    logsUrl: `${root}/logs?api_key_hash=${hash}`,
    settingsUrl: `${root}/keys/${hash}`,
  };
};

const hexToBytes = (hex: string) => {
  if (!/^[0-9a-f]+$/iu.test(hex) || hex.length % 2 !== 0) return;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1)
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
};

/** Verify `X-OpenRouter-Signature` against the exact raw webhook bytes. */
export const verifyOpenRouterWebhookSignature = async (options: {
  body: string | Uint8Array;
  header: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}) => {
  const fields = new Map(
    options.header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    }),
  );
  const timestamp = fields.get("t");
  const supplied = fields.get("v1");
  if (!timestamp || !supplied) return false;
  const timestampNumber = Number(timestamp);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (
    !Number.isFinite(timestampNumber) ||
    Math.abs(now - timestampNumber) > tolerance
  )
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(toBytes(options.secret)).buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${timestamp},`);
  const body = toBytes(options.body);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix);
  payload.set(body, prefix.length);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload.buffer),
  );
  const suppliedBytes = hexToBytes(supplied);
  return suppliedBytes ? constantTimeEqual(expected, suppliedBytes) : false;
};

export const createOpenRouterClient = (config: OpenRouterClientConfig) => {
  if (!config.apiKey && !config.tokenSource)
    throw new Error(
      "createOpenRouterClient() requires either apiKey or tokenSource",
    );
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const batchBaseUrl = (
    config.batchBaseUrl ??
    (config.baseUrl
      ? new URL("../beta", `${baseUrl}/`).toString()
      : DEFAULT_BATCH_BASE_URL)
  ).replace(/\/$/, "");
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const allowedModels = config.allowedModels
    ? [...config.allowedModels]
    : undefined;

  const requestRawAt = async (
    rootUrl: string,
    path: string,
    options: OpenRouterHttpRequestOptions = {},
  ) => {
    const token = config.tokenSource
      ? await Promise.resolve(config.tokenSource())
      : config.apiKey!;
    const suppliedHeaders =
      typeof config.headers === "function"
        ? await config.headers()
        : (config.headers ?? {});
    const headers = new Headers(suppliedHeaders);
    new Headers(options.headers).forEach((value, key) =>
      headers.set(key, value),
    );
    headers.set("Authorization", `Bearer ${token}`);
    let body: BodyInit | undefined;
    if (options.body instanceof FormData || options.body instanceof Blob) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    const { query, ...requestInit } = options;
    const response = await fetchImpl(
      withQuery(`${rootUrl}${normalizePath(path)}`, options.query),
      { ...requestInit, body, headers },
    );
    if (!response.ok) {
      throw ProviderError.fromResponse(
        "openrouter",
        response.status,
        await response.text(),
      );
    }
    return response;
  };

  const requestRaw = (
    path: string,
    options: OpenRouterHttpRequestOptions = {},
  ) => requestRawAt(baseUrl, path, options);

  const request = async <T>(
    path: string,
    options: OpenRouterHttpRequestOptions = {},
  ): Promise<T> => (await requestRaw(path, options)).json() as Promise<T>;

  const requestBatch = async <T>(
    path: string,
    options: OpenRouterHttpRequestOptions = {},
  ): Promise<T> =>
    (await requestRawAt(batchBaseUrl, path, options)).json() as Promise<T>;

  const getBatch = (id: string) =>
    requestBatch<OpenRouterBatch>(`/batches/${encodeURIComponent(id)}`);

  const listModels = async (
    query?: OpenRouterModelQuery,
  ): Promise<OpenRouterModelList> => {
    const result = await request<OpenRouterModelList>("/models", { query });
    if (!allowedModels) return result;
    return {
      ...result,
      data: result.data.filter((model) =>
        allowedModels.some((rule) =>
          openRouterModelMatchesRule(model.id, rule),
        ),
      ),
    };
  };

  const filterModelList = (result: OpenRouterModelList) => {
    if (!allowedModels) return result;
    return {
      ...result,
      data: result.data.filter((model) =>
        allowedModels.some((rule) =>
          openRouterModelMatchesRule(model.id, rule),
        ),
      ),
    };
  };

  return {
    createAuthCode: (body: OpenRouterCreateAuthCodeRequest) =>
      request<OpenRouterCreateAuthCodeResponse>("/auth/keys/code", {
        body,
        method: "POST",
      }),
    createBatch: (body: OpenRouterCreateBatchRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return requestBatch<OpenRouterBatch>("/batches", {
        body,
        method: "POST",
      });
    },
    createEmbedding: (body: OpenRouterEmbeddingRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return request<OpenRouterEmbeddingResponse>("/embeddings", {
        body,
        method: "POST",
      });
    },
    generateImage: (body: OpenRouterImageRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return request<OpenRouterImageResponse>("/images", {
        body,
        method: "POST",
      });
    },
    deleteFile: (id: string, workspaceId?: string) =>
      request<{ id: string; type: "file_deleted" }>(
        `/files/${encodeURIComponent(id)}`,
        { method: "DELETE", query: { workspace_id: workspaceId } },
      ),
    downloadFile: (id: string, workspaceId?: string) =>
      requestRaw(`/files/${encodeURIComponent(id)}/content`, {
        query: { workspace_id: workspaceId },
      }),
    downloadVideo: (id: string, index = 0) =>
      requestRaw(`/videos/${encodeURIComponent(id)}/content`, {
        query: { index },
      }),
    generateVideo: (body: OpenRouterVideoRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return request<OpenRouterVideoJob>("/videos", {
        body,
        method: "POST",
      });
    },
    getBatch,
    getCredits: () => request<{ data: Record<string, number> }>("/credits"),
    getCurrentKey: () => request<{ data: Record<string, unknown> }>("/key"),
    getFile: (id: string, workspaceId?: string) =>
      request<OpenRouterFile>(`/files/${encodeURIComponent(id)}`, {
        query: { workspace_id: workspaceId },
      }),
    getGeneration: (id: string) =>
      request<{ data: Record<string, unknown> }>("/generation", {
        query: { id },
      }),
    getGenerationContent: (id: string) =>
      request<Record<string, unknown>>("/generation/content", {
        query: { id },
      }),
    getModelEndpoints: (model: string) => {
      assertAllowedModel(model, allowedModels);
      return request<Record<string, unknown>>(
        `/models/${encodeModelPath(model)}/endpoints`,
      );
    },
    getModel: (model: string) => {
      assertAllowedModel(model, allowedModels);
      return request<{ data: OpenRouterModel }>(
        `/model/${encodeModelPath(model)}`,
      );
    },
    getImageModelEndpoints: (model: string) => {
      assertAllowedModel(model, allowedModels);
      return request<OpenRouterImageModelEndpoints>(
        `/images/models/${encodeModelPath(model)}/endpoints`,
      );
    },
    getVideo: (id: string) =>
      request<OpenRouterVideoJob>(`/videos/${encodeURIComponent(id)}`),
    listImageModels: async () =>
      filterModelList(await request<OpenRouterModelList>("/images/models")),
    listFiles: (query?: {
      cursor?: string;
      limit?: number;
      workspace_id?: string;
    }) => request<OpenRouterFileList>("/files", { query }),
    listModels,
    listUserModels: async () =>
      filterModelList(await request<OpenRouterModelList>("/models/user")),
    listZdrEndpoints: async () => {
      const result = await request<{ data: OpenRouterZdrEndpoint[] }>(
        "/endpoints/zdr",
      );
      if (!allowedModels) return result;
      return {
        ...result,
        data: result.data.filter((endpoint) =>
          allowedModels.some((rule) =>
            openRouterModelMatchesRule(endpoint.model_id, rule),
          ),
        ),
      };
    },
    countModels: (outputModalities?: string) =>
      request<{ data: { count: number } }>("/models/count", {
        query: { output_modalities: outputModalities },
      }),
    listPresets: (offset = 0, limit = 100) =>
      request<{ data: Record<string, unknown>[]; total_count: number }>(
        "/presets",
        { query: { limit, offset } },
      ),
    listPresetVersions: (slug: string, offset = 0, limit = 100) =>
      request<{ data: Record<string, unknown>[]; total_count: number }>(
        `/presets/${encodeURIComponent(slug)}/versions`,
        { query: { limit, offset } },
      ),
    listProviders: () =>
      request<{ data: Record<string, unknown>[] }>("/providers"),
    listRerankModels: async () =>
      filterModelList(await request<OpenRouterModelList>("/rerank/models")),
    listVideoModels: async () =>
      filterModelList(await request<OpenRouterModelList>("/videos/models")),
    request,
    requestRaw,
    streamImage: async function* (
      body: Omit<OpenRouterImageRequest, "stream">,
      options: Omit<OpenRouterHttpRequestOptions, "body" | "method"> = {},
    ) {
      assertAllowedModel(body.model, allowedModels);
      const response = await requestRaw("/images", {
        ...options,
        body: { ...body, stream: true },
        method: "POST",
      });
      yield* parseImageSSE(response);
    },
    respond: (body: OpenRouterResponsesRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return body.stream
        ? requestRaw("/responses", { body, method: "POST" })
        : request<Record<string, unknown>>("/responses", {
            body,
            method: "POST",
          });
    },
    rerank: (body: OpenRouterRerankRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return request<OpenRouterRerankResponse>("/rerank", {
        body,
        method: "POST",
      });
    },
    speak: (body: OpenRouterSpeechRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return requestRaw("/audio/speech", { body, method: "POST" });
    },
    transcribe: (body: OpenRouterTranscriptionRequest | FormData) => {
      if (body instanceof FormData) {
        const model = body.get("model");
        if (typeof model !== "string")
          throw new Error("OpenRouter transcription FormData requires model");
        assertAllowedModel(model, allowedModels);
      } else {
        assertAllowedModel(body.model, allowedModels);
      }
      return request<Record<string, unknown>>("/audio/transcriptions", {
        body,
        method: "POST",
      });
    },
    uploadFile: (
      file: Blob,
      options: { filename?: string; workspaceId?: string } = {},
    ) => {
      const body = new FormData();
      if (options.filename) body.append("file", file, options.filename);
      else body.append("file", file);
      return request<OpenRouterFile>("/files", {
        body,
        method: "POST",
        query: { workspace_id: options.workspaceId },
      });
    },
    waitForBatch: async (
      id: string,
      options: {
        intervalMs?: number;
        signal?: AbortSignal;
        timeoutMs?: number;
      } = {},
    ) => {
      const intervalMs = options.intervalMs ?? 1_000;
      const timeoutMs = options.timeoutMs;
      if (!Number.isFinite(intervalMs) || intervalMs < 0)
        throw new Error("OpenRouter batch intervalMs must be non-negative");
      if (
        timeoutMs !== undefined &&
        (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      )
        throw new Error("OpenRouter batch timeoutMs must be non-negative");
      const startedAt = Date.now();
      for (;;) {
        options.signal?.throwIfAborted();
        // eslint-disable-next-line no-await-in-loop
        const batch = await getBatch(id);
        if (TERMINAL_BATCH_STATUSES.has(batch.status)) return batch;
        if (
          timeoutMs !== undefined &&
          Date.now() - startedAt + intervalMs > timeoutMs
        )
          throw new Error(`Timed out waiting for OpenRouter batch "${id}"`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, intervalMs);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      }
    },
  };
};
