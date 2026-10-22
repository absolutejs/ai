import { expect, test } from "bun:test";
import { ProviderError } from "../src/ai/errors/providerError";
import { withResilience } from "../src/ai/resilience";
import { streamWithProviderFallback } from "../src/ai/providerFallback";
import type { AIChunk, AIProviderStreamParams } from "../types/ai";
const params = { model: "primary", messages: [] } as AIProviderStreamParams;
const rejected = () =>
  new ProviderError({
    provider: "openai",
    type: "credit_balance_exhausted",
    message: "No credits",
    retryable: true,
  });
const collect = async (stream: AsyncIterable<AIChunk>) => {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  return result;
};
test("billing rejection blocks only the configured provider without retry", async () => {
  let calls = 0;
  const provider = withResilience(
    {
      stream: async function* () {
        calls++;
        throw rejected();
      },
    },
    "billing-fixture",
  );
  for (let i = 0; i < 3; i++)
    await expect(collect(provider.stream(params))).rejects.toBeInstanceOf(
      ProviderError,
    );
  expect(calls).toBe(1);
  const other = withResilience(
    {
      stream: async function* () {
        yield { type: "text", content: "healthy" };
      },
    },
    "billing-fixture",
  );
  expect(await collect(other.stream(params))).toHaveLength(1);
});
test("structured quota HTTP429 is not transient", () => {
  const error = ProviderError.fromResponse(
    "openai",
    429,
    JSON.stringify({ error: { code: "insufficient_quota" } }),
  );
  expect(error.billingUnavailable).toBe(true);
  expect(error.retryable).toBe(false);
});
test("fallback uses an approved alternate once before any output", async () => {
  const calls: string[] = [];
  const chunks = await collect(
    streamWithProviderFallback({
      models: ["primary", "alternate"],
      stream: async function* (model) {
        calls.push(model);
        if (model === "primary") throw rejected();
        yield { type: "text", content: "Ready" };
      },
    }),
  );
  expect(calls).toEqual(["primary", "alternate"]);
  expect(chunks).toHaveLength(1);
});
test("partial output and aborts never restart on another model", async () => {
  const calls: string[] = [];
  await expect(
    collect(
      streamWithProviderFallback({
        models: ["a", "b"],
        stream: async function* (model) {
          calls.push(model);
          yield { type: "text", content: "Partial" };
          throw rejected();
        },
      }),
    ),
  ).rejects.toThrow("No credits");
  expect(calls).toEqual(["a"]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    collect(
      streamWithProviderFallback({
        models: ["a"],
        signal: controller.signal,
        stream: async function* () {
          throw new Error("must not run");
        },
      }),
    ),
  ).rejects.toThrow();
});
