import { beforeAll, describe, expect, test } from "bun:test";
import {
  configureProviderResilience,
  getProviderHealth,
  withResilience,
} from "../src/ai/resilience";
import { ProviderError } from "../src/ai/errors/providerError";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../types/ai";

const params = { messages: [], model: "test" } as AIProviderStreamParams;

const drain = async (iter: AsyncIterable<AIChunk>) => {
  const out: AIChunk[] = [];
  for await (const chunk of iter) out.push(chunk);

  return out;
};

// A provider that fails its first `failures` calls (before yielding), then
// streams a normal response. `calls` counts how many times stream() ran.
const flakyProvider = (
  failures: number,
  error: () => unknown,
): AIProviderConfig & { calls: number } => {
  const state = { calls: 0 };

  return {
    get calls() {
      return state.calls;
    },
    stream: () =>
      (async function* () {
        state.calls += 1;
        if (state.calls <= failures) throw error();
        yield { content: "ok", type: "text" } as AIChunk;
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as AIChunk;
      })(),
  };
};

beforeAll(() => {
  // Deterministic + fast: tiny backoff, low thresholds.
  configureProviderResilience({
    baseDelayMs: 1,
    failureThreshold: 3,
    maxDelayMs: 4,
    maxRetries: 2,
    openMs: 50,
  });
});

describe("ProviderError classification", () => {
  test("fromResponse marks 529/503/429 retryable, 400/401 not", () => {
    expect(
      ProviderError.fromResponse("anthropic", 529, "overloaded").retryable,
    ).toBe(true);
    expect(ProviderError.fromResponse("openai", 503, "down").retryable).toBe(
      true,
    );
    expect(ProviderError.fromResponse("anthropic", 429, "rate").retryable).toBe(
      true,
    );
    expect(ProviderError.fromResponse("anthropic", 400, "bad").retryable).toBe(
      false,
    );
    expect(ProviderError.fromResponse("openai", 401, "auth").retryable).toBe(
      false,
    );
  });

  test("fromResponse carries provider + status page", () => {
    const err = ProviderError.fromResponse("anthropic", 500, "boom");
    expect(err.provider).toBe("anthropic");
    expect(err.status).toBe(500);
    expect(err.statusPageUrl).toBe("https://status.anthropic.com");
  });

  test("from() passes a ProviderError through unchanged", () => {
    const original = ProviderError.fromResponse("openai", 503, "x");
    expect(ProviderError.from(original, "openai")).toBe(original);
  });

  test("from() classifies connection errors as retryable", () => {
    expect(
      ProviderError.from(new Error("fetch failed"), "openai").retryable,
    ).toBe(true);
    expect(
      ProviderError.from(new Error("ECONNRESET"), "anthropic").retryable,
    ).toBe(true);
    expect(
      ProviderError.from(new Error("totally unknown"), "openai").retryable,
    ).toBe(false);
  });

  test("from() rethrows abort errors instead of wrapping", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(() => ProviderError.from(abort, "openai")).toThrow("aborted");
  });
});

describe("withResilience retry", () => {
  test("retries a transient pre-stream failure then succeeds", async () => {
    const inner = flakyProvider(2, () =>
      ProviderError.fromResponse("openai", 529, "overloaded"),
    );
    const wrapped = withResilience(inner, "retry-success");
    const chunks = await drain(wrapped.stream(params));
    expect(chunks).toHaveLength(2);
    expect(inner.calls).toBe(3); // 2 failures + 1 success
    expect(getProviderHealth("retry-success").healthy).toBe(true);
  });

  test("does NOT retry a non-retryable error", async () => {
    const inner = flakyProvider(1, () =>
      ProviderError.fromResponse("openai", 400, "bad request"),
    );
    const wrapped = withResilience(inner, "no-retry-400");
    await expect(drain(wrapped.stream(params))).rejects.toMatchObject({
      status: 400,
    });
    expect(inner.calls).toBe(1);
  });

  test("does NOT retry once a chunk has streamed (mid-stream failure)", async () => {
    let calls = 0;
    const inner: AIProviderConfig = {
      stream: () =>
        (async function* () {
          calls += 1;
          yield { content: "partial", type: "text" } as AIChunk;
          throw ProviderError.fromResponse(
            "anthropic",
            529,
            "overloaded mid-stream",
          );
        })(),
    };
    const wrapped = withResilience(inner, "midstream");
    const out: AIChunk[] = [];
    await expect(
      (async () => {
        for await (const c of wrapped.stream(params)) out.push(c);
      })(),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(1); // not retried
    expect(out).toHaveLength(1); // the partial chunk was delivered
  });
});

describe("circuit breaker", () => {
  test("opens after the failure threshold and fails fast, exposed via health", async () => {
    const inner = flakyProvider(Number.MAX_SAFE_INTEGER, () =>
      ProviderError.fromResponse("openai", 503, "down"),
    );
    const wrapped = withResilience(inner, "breaker");

    // Each call retries maxRetries times then records ONE failure. 3 failed
    // requests (failureThreshold) trip the breaker.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(drain(wrapped.stream(params))).rejects.toBeInstanceOf(
        ProviderError,
      );
    }

    const health = getProviderHealth("breaker");
    expect(health.healthy).toBe(false);
    expect(health.state).toBe("open");

    const callsBefore = inner.calls;
    // Next call should fail fast WITHOUT hitting the provider.
    await expect(drain(wrapped.stream(params))).rejects.toMatchObject({
      message: expect.stringContaining("circuit open"),
    });
    expect(inner.calls).toBe(callsBefore);
  });
});
