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
};

export type OpenRouterImageResponse = {
  created: number;
  data: Array<{ b64_json: string; media_type?: string }>;
  usage?: Record<string, number>;
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
    query?: OpenRouterHttpRequestOptions["query"],
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
    generateVideo: (body: OpenRouterVideoRequest) => {
      assertAllowedModel(body.model, allowedModels);
      return request<Record<string, unknown>>("/videos", {
        body,
        method: "POST",
      });
    },
    getBatch: (id: string) =>
      request<Record<string, unknown>>(`/batches/${encodeURIComponent(id)}`),
    getCredits: () => request<{ data: Record<string, number> }>("/credits"),
    getCurrentKey: () => request<{ data: Record<string, unknown> }>("/key"),
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
    getVideo: (id: string) =>
      request<Record<string, unknown>>(`/videos/${encodeURIComponent(id)}`),
    listImageModels: async () =>
      filterModelList(await request<OpenRouterModelList>("/images/models")),
    listModels,
    listPresets: (offset = 0, limit = 100) =>
      request<{ data: Record<string, unknown>[]; total_count: number }>(
        "/presets",
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
  };
};
