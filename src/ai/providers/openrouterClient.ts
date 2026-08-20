import { ProviderError } from "../errors/providerError";

export type OpenRouterClientConfig = {
  allowedModels?: readonly string[];
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  tokenSource?: () => Promise<string> | string;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: Record<string, unknown>;
  pricing?: Record<string, string>;
  supported_parameters?: string[] | Record<string, unknown>;
  [field: string]: unknown;
};

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
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
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
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const allowedModels = config.allowedModels
    ? [...config.allowedModels]
    : undefined;

  const requestRaw = async (
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
      withQuery(`${baseUrl}${normalizePath(path)}`, options.query),
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

  const request = async <T>(
    path: string,
    options: OpenRouterHttpRequestOptions = {},
  ): Promise<T> => (await requestRaw(path, options)).json() as Promise<T>;

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
    cancelBatch: (id: string) =>
      request<Record<string, unknown>>(
        `/batches/${encodeURIComponent(id)}/cancel`,
        {
          method: "POST",
        },
      ),
    createBatch: (body: Record<string, unknown>) =>
      request<Record<string, unknown>>("/batches", { body, method: "POST" }),
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
    getBatch: (id: string) =>
      request<Record<string, unknown>>(`/batches/${encodeURIComponent(id)}`),
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
  };
};
