import { describe, expect, test } from "bun:test";
import type { AIChunk, AIProviderConfig } from "../types/ai";
import { anthropic } from "../src/ai/providers/anthropic";
import { ProviderError } from "../src/ai/errors/providerError";
import {
  createProviderProxyResponse,
  remoteProvider,
} from "../src/ai/providerProxy";

const params = {
  messages: [{ content: "hello", role: "user" as const }],
  model: "test-model",
  temperature: 0,
};

describe("provider proxy", () => {
  test("round-trips normalized chunks and strips process-only callbacks", async () => {
    let received: unknown;
    const provider: AIProviderConfig = {
      stream: async function* (input) {
        received = input;
        yield { content: "hello", type: "text" };
        yield {
          stopReason: "end_turn",
          type: "done",
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
    };
    const remote = remoteProvider({
      fetch: async (_input, init) =>
        createProviderProxyResponse(provider, JSON.parse(String(init?.body)), {
          heartbeatMs: 0,
        }),
      headers: { authorization: "Bearer scoped-token" },
      url: "https://control.test/provider",
    });

    const chunks: AIChunk[] = [];
    for await (const chunk of remote.stream({
      ...params,
      onUsage: () => {
        throw new Error("must not cross transport");
      },
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { content: "hello", type: "text" },
      {
        stopReason: "end_turn",
        type: "done",
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    ]);
    expect(received).toMatchObject(params);
    expect(received).not.toHaveProperty("onUsage");
  });

  test("emits heartbeat comments during provider silence", async () => {
    const provider: AIProviderConfig = {
      stream: async function* () {
        await Bun.sleep(11);
        yield { content: "first", type: "text" };
        await Bun.sleep(11);
        yield { type: "done" };
      },
    };
    const response = await createProviderProxyResponse(provider, params, {
      heartbeatMs: 5,
    });
    const body = await response.text();
    expect(body).toContain(": ping\n\n");
    expect(body.match(/: ping/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("client cancellation aborts the provider without reporting an error", async () => {
    const errors: unknown[] = [];
    let providerAborted = false;
    const provider: AIProviderConfig = {
      stream: async function* ({ signal }) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        providerAborted = signal?.aborted ?? false;
        yield { content: "late", type: "text" };
      },
    };
    const response = await createProviderProxyResponse(provider, params, {
      heartbeatMs: 0,
      onError: (error) => {
        errors.push(error);
      },
    });
    const reader = response.body!.getReader();

    await reader.cancel("client disconnected");
    await Bun.sleep(0);

    expect(providerAborted).toBe(true);
    expect(errors).toEqual([]);
  });

  test("rejects malformed requests before invoking a provider", async () => {
    let called = false;
    const provider: AIProviderConfig = {
      stream: async function* () {
        called = true;
      },
    };
    const response = await createProviderProxyResponse(provider, {
      messages: [],
    });
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("anthropic uses the injected fetch transport", async () => {
    let called = false;
    const provider = anthropic({
      apiKey: "secret",
      fetch: async () => {
        called = true;
        return new Response("denied", { status: 403 });
      },
    });
    const consume = async () => {
      for await (const _chunk of provider.stream(params)) {
        // no-op
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ProviderError);
    expect(called).toBe(true);
  });

  test("propagates structured provider errors through the stream", async () => {
    const provider: AIProviderConfig = {
      stream: async function* () {
        throw new ProviderError({
          message: "provider overloaded",
          provider: "anthropic",
          retryable: true,
          status: 529,
        });
      },
    };
    const remote = remoteProvider({
      fetch: async (_input, init) =>
        createProviderProxyResponse(provider, JSON.parse(String(init?.body)), {
          heartbeatMs: 0,
        }),
      url: "https://control.test/provider",
    });
    const consume = async () => {
      for await (const _chunk of remote.stream(params)) {
        // no-op
      }
    };
    try {
      await consume();
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        provider: "anthropic",
        retryable: true,
        status: 529,
      });
    }
  });
});
