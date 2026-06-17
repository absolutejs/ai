import { afterEach, describe, expect, test } from "bun:test";
import { fetchProviderApiStatus } from "../src/ai/providerStatusMonitor";
import {
  getProviderHealth,
  setProviderAvailability,
  withResilience,
} from "../src/ai/resilience";
import { ProviderError } from "../src/ai/errors/providerError";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../types/ai";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const mockFetch = (routes: Record<string, unknown>) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return { ok: false, status: 404 } as Response;

    return {
      json: async () => routes[key],
      ok: true,
      status: 200,
    } as Response;
  }) as typeof fetch;
};

const params = { messages: [], model: "test" } as AIProviderStreamParams;
const okProvider: AIProviderConfig = {
  stream: () =>
    (async function* () {
      yield { content: "ok", type: "text" } as AIChunk;
    })(),
};
const drain = async (iter: AsyncIterable<AIChunk>) => {
  const out: AIChunk[] = [];
  for await (const chunk of iter) out.push(chunk);

  return out;
};

describe("fetchProviderApiStatus", () => {
  test("reads the named API component (down)", async () => {
    mockFetch({
      "components.json": {
        components: [
          { name: "claude.ai", status: "operational" },
          { name: "Claude API (api.anthropic.com)", status: "major_outage" },
        ],
      },
    });
    const status = await fetchProviderApiStatus("anthropic");
    expect(status.available).toBe(false);
    expect(status.indicator).toBe("major_outage");
    expect(status.componentName).toBe("Claude API (api.anthropic.com)");
    expect(status.statusPageUrl).toBe("https://status.claude.com");
  });

  test("degraded component still counts as available", async () => {
    mockFetch({
      "components.json": {
        components: [
          { name: "Chat Completions", status: "degraded_performance" },
        ],
      },
    });
    const status = await fetchProviderApiStatus("openai");
    expect(status.available).toBe(true);
    expect(status.indicator).toBe("degraded_performance");
  });

  test("falls back to overall page indicator when component missing", async () => {
    mockFetch({
      "components.json": {
        components: [{ name: "Unrelated", status: "operational" }],
      },
      "status.json": { status: { description: "x", indicator: "critical" } },
    });
    const status = await fetchProviderApiStatus("openai");
    expect(status.available).toBe(false);
    expect(status.componentName).toBe(null);
    expect(status.indicator).toBe("critical");
  });

  test("network failure resolves to available/unknown (never blocks)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const status = await fetchProviderApiStatus("anthropic");
    expect(status.available).toBe(true);
    expect(status.indicator).toBe("unknown");
  });
});

describe("setProviderAvailability primes the breaker", () => {
  test("external down → fail fast without calling the provider", async () => {
    let calls = 0;
    const counted: AIProviderConfig = {
      stream: () =>
        (async function* () {
          calls += 1;
          yield* okProvider.stream(params);
        })(),
    };
    const wrapped = withResilience(counted, "ext-down");

    setProviderAvailability("ext-down", {
      available: false,
      indicator: "major_outage",
      reason: "outage",
    });
    await expect(drain(wrapped.stream(params))).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(calls).toBe(0);
    expect(getProviderHealth("ext-down").healthy).toBe(false);

    // Recovery clears the external block.
    setProviderAvailability("ext-down", { available: true });
    const chunks = await drain(wrapped.stream(params));
    expect(chunks).toHaveLength(1);
    expect(getProviderHealth("ext-down").healthy).toBe(true);
  });
});
