import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/ai/errors/providerError";
import { openrouter } from "../src/ai/providers/openrouter";
import type { AIChunk, AIProviderStreamParams } from "../types/ai";

const params = (
  model: string,
  extra: Partial<AIProviderStreamParams> = {},
): AIProviderStreamParams => ({
  messages: [{ content: "Hello", role: "user" }],
  model,
  ...extra,
});

const drain = async (source: AsyncIterable<AIChunk>) => {
  const chunks: AIChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);

  return chunks;
};

const successfulStream = () =>
  [
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":5},"prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":10},"cost":0.001,"cost_details":{"upstream_inference_cost":0.0009}}}',
    "data: [DONE]",
    "",
  ].join("\n");

describe("openrouter", () => {
  test("maps routing policy, attribution headers, and usage metadata", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { init, input };

      return new Response(successfulStream(), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    let usage:
      | {
          cacheReadInputTokens?: number;
          cacheWriteInputTokens?: number;
          costCredits?: number;
          inputTokens: number;
          model: string;
          outputTokens: number;
          provider?: string;
          reasoningTokens?: number;
          upstreamInferenceCostCredits?: number;
        }
      | undefined;
    const provider = openrouter({
      allowedModels: ["anthropic/*", "google/*"],
      allowedProviders: ["anthropic", "google-vertex"],
      apiKey: "test-key",
      appCategories: ["cloud-agent"],
      appName: "AbsoluteJS Test",
      appUrl: "https://example.com",
      fetch: mockFetch,
      headers: { "X-Custom": "custom" },
      routing: {
        allowFallbacks: false,
        dataCollection: "deny",
        maxPrice: { completion: 2, prompt: 1 },
        order: ["anthropic"],
        preferredMaxLatency: { p90: 3 },
        preferredMinThroughput: 50,
        quantizations: ["fp16"],
        requireParameters: true,
        sort: { by: "price", partition: "none" },
        zdr: true,
      },
    });

    await drain(
      provider.stream(
        params("~anthropic/claude-sonnet-latest", {
          onUsage: (value) => {
            usage = value;
          },
        }),
      ),
    );

    expect(String(request?.input)).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("http-referer")).toBe("https://example.com");
    expect(headers.get("x-openrouter-title")).toBe("AbsoluteJS Test");
    expect(headers.get("x-openrouter-categories")).toBe("cloud-agent");
    expect(headers.get("x-custom")).toBe("custom");

    const body = JSON.parse(String(request?.init?.body));
    expect(body.provider).toEqual({
      allow_fallbacks: false,
      data_collection: "deny",
      max_price: { completion: 2, prompt: 1 },
      only: ["anthropic", "google-vertex"],
      order: ["anthropic"],
      preferred_max_latency: { p90: 3 },
      preferred_min_throughput: 50,
      quantizations: ["fp16"],
      require_parameters: true,
      sort: { by: "price", partition: "none" },
      zdr: true,
    });
    expect(usage).toEqual({
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 10,
      costCredits: 0.001,
      inputTokens: 80,
      model: "~anthropic/claude-sonnet-latest",
      outputTokens: 12,
      provider: "openrouter",
      reasoningTokens: 5,
      upstreamInferenceCostCredits: 0.0009,
    });
  });

  test("rejects a model outside the local allowlist before fetch", () => {
    let fetches = 0;
    const provider = openrouter({
      allowedModels: ["anthropic/*", "google/*"],
      apiKey: "test-key",
      fetch: (async () => {
        fetches += 1;
        return new Response(successfulStream());
      }) as typeof fetch,
    });

    expect(() => provider.stream(params("openrouter/auto"))).toThrow(
      'OpenRouter model "openrouter/auto" is not allowed',
    );
    expect(fetches).toBe(0);
  });

  test("normalizes namespaced OpenAI reasoning through OpenRouter", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = openrouter({
      allowedModels: ["openai/*"],
      apiKey: "test-key",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(successfulStream());
      }) as typeof fetch,
    });

    await drain(
      provider.stream(
        params("openai/gpt-5", {
          maxTokens: 5000,
          reasoning: { effort: "max" },
          temperature: 0.2,
          topP: 0.9,
        }),
      ),
    );

    expect(body?.max_completion_tokens).toBe(5000);
    expect(body?.reasoning).toEqual({ effort: "max" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  test("rejects routing entries outside the provider allowlist", () => {
    expect(() =>
      openrouter({
        allowedProviders: ["anthropic", "google-vertex"],
        apiKey: "test-key",
        routing: { order: ["deepinfra"] },
      }),
    ).toThrow('openrouter() provider "deepinfra" is outside allowedProviders');
  });

  test("attributes HTTP errors to OpenRouter", async () => {
    const provider = openrouter({
      apiKey: "bad-key",
      fetch: (async () =>
        new Response("unauthorized", { status: 401 })) as typeof fetch,
    });

    let error: unknown;
    try {
      await drain(provider.stream(params("anthropic/claude-haiku-4.5")));
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe("openrouter");
    expect((error as ProviderError).status).toBe(401);
    expect((error as ProviderError).statusPageUrl).toBe(
      "https://status.openrouter.ai",
    );
  });
});
