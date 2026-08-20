import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/ai/errors/providerError";
import {
  openrouter,
  openrouterMessages,
  openrouterResponses,
} from "../src/ai/providers/openrouter";
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

  test("supports per-request fallbacks, presets, caching, and server features", async () => {
    let request: { init?: RequestInit } | undefined;
    const provider = openrouter({
      allowedModels: ["anthropic/*", "openai/*"],
      allowedPresets: ["support-agent"],
      allowedProviders: ["anthropic", "openai"],
      apiKey: "test-key",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        request = { init };
        return new Response(successfulStream());
      }) as typeof fetch,
    });

    await drain(
      provider.stream(
        params("anthropic/claude-sonnet-4.6", {
          providerOptions: {
            openrouter: {
              cacheControl: { ttl: "1h", type: "ephemeral" },
              extraBody: { top_k: 40 },
              fallbackModels: ["openai/gpt-5.2"],
              includeReasoning: true,
              maxToolCalls: 5,
              plugins: [{ id: "response-healing" }],
              promptCacheKey: "conversation-cache",
              promptCacheOptions: { mode: "explicit", ttl: "30m" },
              preset: "support-agent",
              responseCache: { clear: true, enabled: true, ttlSeconds: 600 },
              reasoning: {
                context: "all_turns",
                effort: "xhigh",
                mode: "pro",
              },
              routing: { allowFallbacks: true, only: ["anthropic"] },
              serverTools: [
                {
                  parameters: { max_results: 3 },
                  type: "openrouter:web_search",
                },
              ],
              serviceTier: "flex",
              sessionId: "conversation-123",
              stopServerToolsWhen: [{ type: "max_cost", value: 0.02 }],
              transforms: ["middle-out"],
              user: "user-123",
              verbosity: "low",
            },
          },
          systemPrompt: "You are helpful",
          tools: [
            {
              description: "Get weather",
              input_schema: { type: "object" },
              name: "weather",
            },
          ],
        }),
      ),
    );

    const headers = new Headers(request?.init?.headers);
    expect(headers.get("x-openrouter-cache")).toBe("true");
    expect(headers.get("x-openrouter-cache-clear")).toBe("true");
    expect(headers.get("x-openrouter-cache-ttl")).toBe("600");
    expect(headers.get("x-openrouter-metadata")).toBe("enabled");
    expect(headers.get("x-session-id")).toBe("conversation-123");
    const body = JSON.parse(String(request?.init?.body));
    expect(body.models).toEqual(["openai/gpt-5.2"]);
    expect(body.messages[0]).toEqual({
      content: "You are helpful",
      role: "system",
    });
    expect(body.cache_control).toEqual({ ttl: "1h", type: "ephemeral" });
    expect(body.prompt_cache_key).toBe("conversation-cache");
    expect(body.prompt_cache_options).toEqual({
      mode: "explicit",
      ttl: "30m",
    });
    expect(body.reasoning).toEqual({
      context: "all_turns",
      effort: "xhigh",
      mode: "pro",
    });
    expect(body.preset).toBe("support-agent");
    expect(body.service_tier).toBe("flex");
    expect(body.top_k).toBe(40);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[1]).toEqual({
      parameters: { max_results: 3 },
      type: "openrouter:web_search",
    });
    expect(body.provider.only).toEqual(["anthropic"]);
  });

  test("prevents indirect models and escape hatches from bypassing policy", async () => {
    const provider = openrouter({
      allowedModels: ["anthropic/*"],
      apiKey: "test-key",
      fetch: (async () => new Response(successfulStream())) as typeof fetch,
    });
    await expect(
      drain(
        provider.stream(
          params("anthropic/claude-sonnet-4.6", {
            providerOptions: {
              openrouter: { fallbackModels: ["deepseek/deepseek-v3"] },
            },
          }),
        ),
      ),
    ).rejects.toThrow('OpenRouter model "deepseek/deepseek-v3" is not allowed');
    await expect(
      drain(
        provider.stream(
          params("anthropic/claude-sonnet-4.6", {
            providerOptions: {
              openrouter: {
                serverTools: [
                  {
                    parameters: { model: "deepseek/deepseek-v3" },
                    type: "openrouter:subagent",
                  },
                ],
              },
            },
          }),
        ),
      ),
    ).rejects.toThrow('OpenRouter model "deepseek/deepseek-v3" is not allowed');
  });

  test("emits citations and resolved router metadata", async () => {
    const stream = [
      'data: {"id":"gen-123","model":"openai/gpt-5.2","service_tier":"flex","openrouter_metadata":{"endpoints":{"available":[{"provider":"OpenAI","selected":true}]}},"choices":[{"delta":{"content":"Source","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com","title":"Example","start_index":0,"end_index":6}}]}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = openrouter({
      apiKey: "test-key",
      fetch: (async () =>
        new Response(stream, {
          headers: {
            "X-Generation-Id": "gen-header",
            "X-OpenRouter-Cache-Status": "HIT",
          },
        })) as typeof fetch,
    });
    const chunks = await drain(provider.stream(params("openai/gpt-5.2")));
    expect(chunks.find((chunk) => chunk.type === "citation")).toEqual({
      content: undefined,
      endIndex: 6,
      startIndex: 0,
      title: "Example",
      type: "citation",
      url: "https://example.com",
    });
    const done = chunks.find((chunk) => chunk.type === "done");
    expect(done?.metadata?.generationId).toBe("gen-123");
    expect(done?.metadata?.provider).toBe("OpenAI");
    expect(done?.metadata?.serviceTier).toBe("flex");
  });

  test("supports the OpenRouter Responses API with the same policies", async () => {
    let request: { input?: RequestInfo | URL; init?: RequestInit } = {};
    const responseStream = [
      "event: response.output_text.delta",
      'data: {"delta":"ok"}',
      "",
      "event: response.completed",
      'data: {"response":{"id":"resp-1","model":"openai/gpt-5","provider":"OpenAI","service_tier":"flex","openrouter_metadata":{"trace_id":"trace-1"},"usage":{"input_tokens":12,"output_tokens":4,"cost":0.002,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":2},"output_tokens_details":{"reasoning_tokens":1},"cost_details":{"upstream_inference_cost":0.0018},"server_tool_use":{"web_search_calls":1}}}}',
      "",
    ].join("\n");
    const provider = openrouterResponses({
      allowedModels: ["openai/*", "anthropic/*"],
      allowedProviders: ["openai"],
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        request = { init, input };
        return new Response(responseStream);
      }) as typeof fetch,
    });
    const chunks = await drain(
      provider.stream(
        params("openai/gpt-5", {
          providerOptions: {
            openrouter: {
              fallbackModels: ["anthropic/claude-sonnet-4.6"],
              serviceTier: "flex",
            },
          },
          reasoning: { effort: "low" },
        }),
      ),
    );
    expect(String(request.input)).toBe(
      "https://openrouter.ai/api/v1/responses",
    );
    const body = JSON.parse(String(request.init?.body));
    expect(body.models).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(body.provider.only).toEqual(["openai"]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.service_tier).toBe("flex");
    expect(chunks.find((chunk) => chunk.type === "text")).toEqual({
      content: "ok",
      type: "text",
    });
    const done = chunks.find((chunk) => chunk.type === "done");
    expect(done).toEqual({
      metadata: {
        generationId: "resp-1",
        model: "openai/gpt-5",
        provider: "OpenAI",
        providerMetadata: { trace_id: "trace-1" },
        serviceTier: "flex",
      },
      type: "done",
      usage: {
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        costCredits: 0.002,
        inputTokens: 9,
        outputTokens: 4,
        reasoningTokens: 1,
        serverToolUse: { web_search_calls: 1 },
        upstreamInferenceCostCredits: 0.0018,
      },
    });
  });

  test("throws typed OpenRouter errors received after streaming begins", async () => {
    const stream = [
      'data: {"id":"gen-error","error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded","availability":{"code":"capacity_exhausted","retryable":true}}},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}',
      "",
    ].join("\n");
    const provider = openrouter({
      apiKey: "test-key",
      fetch: (async () => new Response(stream)) as typeof fetch,
    });

    let caught: unknown;
    try {
      await drain(provider.stream(params("openai/gpt-5")));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).status).toBe(429);
    expect((caught as ProviderError).type).toBe("rate_limit_exceeded");
    expect((caught as ProviderError).metadata).toEqual({
      availability: { code: "capacity_exhausted", retryable: true },
      error_type: "rate_limit_exceeded",
    });
  });

  test("preserves typed Responses failures", async () => {
    const stream = [
      "event: response.failed",
      'data: {"response":{"id":"resp-error","status":"failed","error":{"code":"server_error","message":"Provider unavailable"},"error_type":"provider_unavailable","availability":{"code":"temporarily_unavailable","retryable":true}}}',
      "",
    ].join("\n");
    const provider = openrouterResponses({
      apiKey: "test-key",
      fetch: (async () => new Response(stream)) as typeof fetch,
    });

    let caught: unknown;
    try {
      await drain(provider.stream(params("openai/gpt-5")));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).type).toBe("provider_unavailable");
    expect((caught as ProviderError).retryable).toBe(true);
    expect((caught as ProviderError).metadata).toMatchObject({
      availability: { code: "temporarily_unavailable", retryable: true },
      id: "resp-error",
    });
  });

  test("supports the native Anthropic Messages skin and hosted-tool replay", async () => {
    let request: { input?: RequestInfo | URL; init?: RequestInit } = {};
    const event = (type: string, data: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify(data)}`;
    const stream = [
      event("message_start", {
        message: {
          id: "msg-1",
          model: "anthropic/claude-sonnet-4.6",
          provider: "Anthropic",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
      event("content_block_start", {
        content_block: {
          id: "srvtoolu-1",
          input: {},
          name: "advisor",
          type: "server_tool_use",
        },
      }),
      event("content_block_delta", {
        delta: {
          partial_json: '{"prompt":"review this"}',
          type: "input_json_delta",
        },
      }),
      event("content_block_stop", {}),
      event("content_block_start", {
        content_block: {
          content: { text: "Use queues", type: "advisor_result" },
          tool_use_id: "srvtoolu-1",
          type: "advisor_tool_result",
        },
      }),
      event("content_block_stop", {}),
      event("content_block_delta", {
        delta: { text: "Done", type: "text_delta" },
      }),
      event("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: {
          cost: 0.003,
          output_tokens: 4,
          server_tool_use: { advisor_requests: 1 },
        },
      }),
      event("message_stop", {
        openrouter_metadata: { trace_id: "trace-2" },
      }),
      "",
    ].join("\n\n");
    const provider = openrouterMessages({
      allowedModels: ["anthropic/*"],
      allowedProviders: ["anthropic"],
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        request = { init, input };
        return new Response(stream);
      }) as typeof fetch,
    });
    const chunks = await drain(
      provider.stream(
        params("anthropic/claude-sonnet-4.6", {
          providerOptions: {
            openrouter: {
              messagesTools: [
                {
                  model: "anthropic/claude-opus-4.8",
                  name: "advisor",
                  type: "advisor_20260301",
                },
              ],
            },
          },
        }),
      ),
    );

    expect(String(request.input)).toBe("https://openrouter.ai/api/v1/messages");
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-api-key")).toBeNull();
    const body = JSON.parse(String(request.init?.body));
    expect(body.provider.only).toEqual(["anthropic"]);
    expect(body.tools).toEqual([
      {
        model: "anthropic/claude-opus-4.8",
        name: "advisor",
        type: "advisor_20260301",
      },
    ]);
    expect(
      chunks.filter((chunk) => chunk.type === "provider_event"),
    ).toEqual([
      {
        data: {
          id: "srvtoolu-1",
          input: { prompt: "review this" },
          name: "advisor",
          type: "server_tool_use",
        },
        provider: "openrouter",
        type: "provider_event",
      },
      {
        data: {
          content: { text: "Use queues", type: "advisor_result" },
          tool_use_id: "srvtoolu-1",
          type: "advisor_tool_result",
        },
        provider: "openrouter",
        type: "provider_event",
      },
    ]);
    const done = chunks.find((chunk) => chunk.type === "done");
    expect(done?.metadata).toMatchObject({
      generationId: "msg-1",
      model: "anthropic/claude-sonnet-4.6",
      provider: "Anthropic",
      providerMetadata: { trace_id: "trace-2" },
    });
    expect(done?.usage).toMatchObject({
      costCredits: 0.003,
      inputTokens: 10,
      outputTokens: 4,
      serverToolUse: { advisor_requests: 1 },
    });
  });
});
