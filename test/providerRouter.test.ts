import { expect, test } from "bun:test";
import { createAIProviderRouter } from "../src/ai/providerRouter";
import { inspectAIInput } from "../src/ai/inputCapacity";
import { openaiResponses } from "../src/ai/providers/openaiResponses";
import type { AIProviderConfig, AIProviderStreamParams } from "../types/ai";

test("routes counting, limits and generation to each exact model provider", async () => {
  const seen: string[] = [];
  const make = (model: string, tokens: number): AIProviderConfig => ({
    inputCapacity: {
      countTokens: async (params) => {
        expect(params.model).toBe(model);
        seen.push(`${model}:count`);
        return tokens;
      },
      getLimits: async (params) => {
        expect(params.model).toBe(model);
        seen.push(`${model}:limits`);
        return { maxInputTokens: 1000, maxOutputTokens: 100 };
      },
    },
    stream: async function* (params) {
      expect(params.model).toBe(model);
      seen.push(`${model}:stream`);
      yield { type: "text", content: model };
    },
  });
  const routes = { prepare: make("prepare", 10), answer: make("answer", 20) };
  const router = createAIProviderRouter(routes);
  routes.answer = routes.prepare;
  for (const model of ["prepare", "answer"]) {
    const params: AIProviderStreamParams = {
      model,
      messages: [],
      maxTokens: 10,
    };
    expect((await inspectAIInput(router, params)).inputTokens).toBe(
      model === "prepare" ? 10 : 20,
    );
    for await (const chunk of router.stream(params))
      expect(chunk).toEqual({ type: "text", content: model });
  }
  expect(seen).toHaveLength(6);
  await expect(
    inspectAIInput(router, { model: "toString", messages: [] }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
});

test("missing capacity and cancellation fail before generation", async () => {
  let calls = 0;
  const router = createAIProviderRouter({
    raw: {
      stream: async function* () {
        calls++;
        yield { type: "text", content: "raw" };
      },
    },
  });
  await expect(
    inspectAIInput(router, { model: "raw", messages: [] }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  const signal = AbortSignal.abort(new Error("cancelled"));
  expect(() => router.stream({ model: "raw", messages: [], signal })).toThrow(
    "cancelled",
  );
  expect(calls).toBe(0);
});

test("Luna capacity uses its documented separate input, output and context limits", async () => {
  const provider = openaiResponses({
    apiKey: "synthetic-test-key",
    fetch: async () => {
      throw Error("Unexpected network request");
    },
  });
  expect(
    await provider.inputCapacity?.getLimits({
      model: "gpt-5.6-luna",
      messages: [],
    }),
  ).toEqual({
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
    contextWindowTokens: 1050000,
  });
});

test("tool turns preserve each actual processing tier for per-turn pricing", async () => {
  const { streamAIWithTools } = await import("../src/ai/streamAIWithTools");
  let calls = 0;
  const provider: AIProviderConfig = {
    stream: async function* () {
      calls++;
      if (calls === 1)
        yield { type: "tool_use", id: "lookup", name: "lookup", input: {} };
      else yield { type: "text", content: "Finished" };
      yield {
        type: "done",
        usage: { inputTokens: 10, outputTokens: 2 },
        metadata: {
          serviceTier: calls === 1 ? "priority" : "default",
          model: "synthetic",
          generationId: `generation-${calls}`,
        },
      };
    },
  };
  const turns = [];
  for await (const event of streamAIWithTools({
    provider,
    model: "synthetic",
    messages: [{ role: "user", content: "Look up the source" }],
    contextPolicy: false,
    tools: {
      lookup: {
        description: "Read the source",
        input: { type: "object", properties: {} },
        handler: async () => "source",
      },
    },
  })) {
    if (event.type === "turn") turns.push(event);
  }
  expect(turns.map((turn) => turn.metadata?.serviceTier)).toEqual([
    "priority",
    "default",
  ]);
  expect(turns.map((turn) => turn.metadata?.generationId)).toEqual([
    "generation-1",
    "generation-2",
  ]);
  expect(turns.map((turn) => turn.usage)).toEqual([
    { inputTokens: 10, outputTokens: 2 },
    { inputTokens: 10, outputTokens: 2 },
  ]);
});

test("routing preserves provider output reservation and context rejection detection", async () => {
  const contextError = new Error("provider-specific context rejection");
  const router = createAIProviderRouter({
    synthetic: {
      inputCapacity: {
        countTokens: async () => 100,
        getLimits: async () => ({
          maxInputTokens: 200,
          maxOutputTokens: 80,
          contextWindowTokens: 150,
        }),
        outputTokens: () => 60,
        isContextError: (error) => error === contextError,
      },
      stream: async function* () {
        yield { type: "text", content: "unused" };
      },
    },
  });
  expect(
    router.inputCapacity?.outputTokens?.({ model: "synthetic", messages: [] }),
  ).toBe(60);
  expect(router.inputCapacity?.isContextError?.(contextError)).toBe(true);
  expect(
    router.inputCapacity?.isContextError?.(new Error("unauthorized")),
  ).toBe(false);
  expect(
    await inspectAIInput(router, { model: "synthetic", messages: [] }),
  ).toMatchObject({ outputTokens: 60, availableInputTokens: 90, fits: false });
});
