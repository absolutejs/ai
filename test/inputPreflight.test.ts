import { expect, test } from "bun:test";
import {
  AIInputPreflightError,
  isAIInputPreflightError,
  requestInputPreflight,
} from "../src/ai/inputPreflight";
import { anthropic } from "../src/ai/providers/anthropic";
const base = {
  provider: "anthropic",
  model: "test",
  operation: "count_tokens" as const,
};
test("retries a reset count request without starting generation", async () => {
  const paths: string[] = [];
  const provider = anthropic({
    apiKey: "secret",
    fetch: (async (url: string) => {
      paths.push(url);
      if (paths.length === 1)
        throw Object.assign(new Error("secret"), { code: "ECONNRESET" });
      return Response.json({ input_tokens: 32 });
    }) as typeof fetch,
  });
  expect(
    await provider.inputCapacity!.countTokens({ model: "test", messages: [] }),
  ).toBe(32);
  expect(paths.length).toBe(2);
  expect(
    paths.every((path) => path.endsWith("/v1/messages/count_tokens")),
  ).toBe(true);
});
test("bounded transient failures retain safe diagnostic evidence", async () => {
  let calls = 0;
  const error = await requestInputPreflight({
    ...base,
    request: async () => {
      calls++;
      throw Object.assign(new Error("secret"), { code: "ECONNRESET" });
    },
  }).catch((error) => error);
  expect(calls).toBe(3);
  expect(error).toBeInstanceOf(AIInputPreflightError);
  expect(isAIInputPreflightError(error)).toBe(true);
  expect(error).toMatchObject({
    attempts: 3,
    generationStarted: false,
    transportCode: "ECONNRESET",
    operation: "count_tokens",
  });
  expect(JSON.stringify(error)).not.toContain("secret");
});
test("auth and DNS errors are not retried", async () => {
  for (const request of [
    async () => new Response('{"error":{"message":"secret"}}', { status: 401 }),
    async () => {
      throw Object.assign(new Error("secret"), { code: "ENOTFOUND" });
    },
  ]) {
    let calls = 0;
    const error = await requestInputPreflight({
      ...base,
      request: async () => {
        calls++;
        return request();
      },
    }).catch((error) => error);
    expect(calls).toBe(1);
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("secret");
  }
});
test("cancellation during backoff prevents another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = requestInputPreflight({
    ...base,
    signal: controller.signal,
    request: async () => {
      calls++;
      setTimeout(() => controller.abort(new Error("cancelled")), 10);
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    },
  });
  await expect(result).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
});
