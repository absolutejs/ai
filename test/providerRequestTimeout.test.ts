import { expect, test } from "bun:test";
import { withProviderRequestTimeout } from "../src/ai/providerRequestTimeout";
import { generateAIWithTools } from "../src/ai/generateAI";
import { testInputCapacity } from "./contextFixture";
import type { AIProviderConfig, AIProviderStreamParams } from "../types/ai";
const params: AIProviderStreamParams = {
  model: "test",
  messages: [],
  maxTokens: 100,
};
const consume = async (provider: AIProviderConfig, input = params) => {
  const chunks = [];
  for await (const chunk of provider.stream(input)) chunks.push(chunk);
  return chunks;
};
test("slow host tools do not consume the next provider request's deadline", async () => {
  let calls = 0;
  const provider: AIProviderConfig = {
    inputCapacity: testInputCapacity,
    stream: async function* () {
      calls += 1;
      if (calls === 1)
        yield { type: "tool_use", id: "lookup", name: "lookup", input: {} };
      else yield { type: "text", content: "Finished" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const result = await generateAIWithTools({
    provider: withProviderRequestTimeout(provider, 50),
    model: "test",
    messages: [{ role: "user", content: "Look up" }],
    maxTurns: 2,
    tools: {
      lookup: {
        description: "Lookup",
        input: { type: "object", properties: {} },
        handler: async () => {
          await Bun.sleep(120);
          return "Found";
        },
      },
    },
  });
  expect(result.text).toBe("Finished");
  expect(calls).toBe(2);
});
test("times out a stalled transport even when it ignores abort", async () => {
  let observed: AbortSignal | undefined;
  const provider: AIProviderConfig = {
    stream: (input) => {
      observed = input.signal;
      return {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      };
    },
  };
  await expect(
    consume(withProviderRequestTimeout(provider, 10)),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(observed?.aborted).toBe(true);
});
test("preserves caller cancellation and never starts an already canceled request", async () => {
  let starts = 0;
  const provider: AIProviderConfig = {
    stream: async function* () {
      starts += 1;
      yield { type: "done" };
    },
  };
  const controller = new AbortController();
  controller.abort(new Error("Caller canceled"));
  await expect(
    consume(withProviderRequestTimeout(provider, 50), {
      ...params,
      signal: controller.signal,
    }),
  ).rejects.toThrow("Caller canceled");
  expect(starts).toBe(0);
});
test("completed requests preserve usage and clear their timeout", async () => {
  let observed: AbortSignal | undefined;
  const provider: AIProviderConfig = {
    inputCapacity: testInputCapacity,
    stream: async function* (input) {
      observed = input.signal;
      yield { type: "done", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
  const wrapped = withProviderRequestTimeout(provider, 10);
  expect(wrapped.inputCapacity).toBe(provider.inputCapacity);
  expect(await consume(wrapped)).toEqual([
    { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
  ]);
  await Bun.sleep(30);
  expect(observed?.aborted).toBe(false);
  expect(() => withProviderRequestTimeout(provider, Infinity)).toThrow(
    RangeError,
  );
});

test("cancellation interrupts an active uncooperative transport without changing its reason", async () => {
  const controller = new AbortController();
  const provider: AIProviderConfig = {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    }),
  };
  const running = consume(withProviderRequestTimeout(provider, 1000), {
    ...params,
    signal: controller.signal,
  });
  controller.abort(new Error("Member stopped"));
  await expect(running).rejects.toThrow("Member stopped");
});
test("timeout preserves already emitted usage evidence instead of implying an unsent request", async () => {
  const provider: AIProviderConfig = {
    stream: async function* () {
      yield { type: "text", content: "Partial" };
      await new Promise(() => {});
    },
  };
  const chunks = [];
  try {
    for await (const chunk of withProviderRequestTimeout(provider, 10).stream(
      params,
    ))
      chunks.push(chunk);
  } catch (error) {
    expect(error).toMatchObject({ name: "TimeoutError" });
  }
  expect(chunks).toEqual([{ type: "text", content: "Partial" }]);
});
