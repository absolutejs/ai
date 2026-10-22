import { expect, test } from "bun:test";
import { streamWithAIContext } from "../src/ai/contextPolicy";
import { prepareAITextInput } from "../src/ai/prepareTextInput";
import { ProviderError, isProviderError } from "../src/ai/errors/providerError";
import { AIInputError } from "../src/ai/inputCapacity";
import { isPermanentAIProviderFailure } from "../src/ai/providerFallback";
import {
  openaiSchema,
  isStrictCompatible,
} from "../src/ai/providers/openaiSchema";
import type { AIChunk, AIProviderConfig } from "../types/ai";
const collect = async (source: AsyncIterable<AIChunk>) => {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
};
const fail = (provider: string) =>
  ProviderError.fromResponse(
    provider,
    400,
    JSON.stringify({
      error: {
        message: "Your credit balance is too low",
        type: "invalid_request_error",
      },
    }),
  );
for (const [primary, alternate] of [
  ["openai", "anthropic"],
  ["anthropic", "openai"],
]) {
  for (const stage of ["preflight", "generation"])
    test(`${primary} to ${alternate} recovers ${stage} before output`, async () => {
      const counts: string[] = [],
        streams: string[] = [];
      const provider: AIProviderConfig = {
        inputCapacity: {
          getLimits: async () => ({
            maxInputTokens: 10000,
            maxOutputTokens: 1000,
            contextWindowTokens: 11000,
          }),
          countTokens: async (params) => {
            counts.push(params.model);
            if (params.model === primary && stage === "preflight")
              throw new AIInputError(
                "capacity_unavailable",
                "Rejected",
                400,
                undefined,
                fail(primary),
              );
            return 10;
          },
        },
        stream: async function* (params) {
          streams.push(params.model);
          if (params.model === primary) throw fail(primary);
          yield { type: "text", content: "Ready" };
          yield { type: "done" };
        },
      };
      const params = { model: primary, messages: [], maxTokens: 100 };
      expect(
        await collect(
          streamWithAIContext(provider, params, {
            providerFallback: { models: [alternate] },
          }),
        ),
      ).toHaveLength(2);
      expect(counts).toEqual([primary, alternate]);
      expect(streams).toEqual(
        stage === "preflight" ? [alternate] : [primary, alternate],
      );
      if (stage === "preflight") {
        const prepared = await prepareAITextInput(provider, params, {
          providerFallback: { models: [alternate] },
        });
        expect(prepared.params.model).toBe(alternate);
        expect(params.model).toBe(primary);
      }
    });
}
test("finite record keys become optional named fields without changing constraints", () => {
  const schema = {
    type: "object",
    properties: {
      details: {
        type: "object",
        propertyNames: { type: "string", enum: ["name", "goal"] },
        additionalProperties: { type: "string" },
      },
    },
  };
  const normalized = openaiSchema(schema);
  expect(normalized).toEqual({
    type: "object",
    properties: {
      details: {
        type: "object",
        properties: { name: { type: "string" }, goal: { type: "string" } },
        additionalProperties: false,
      },
    },
  });
  expect(isStrictCompatible(normalized)).toBe(false);
  expect(schema.properties.details.propertyNames.enum).toEqual([
    "name",
    "goal",
  ]);
  const constrained = {
    type: "object",
    propertyNames: { pattern: "^allowed" },
    additionalProperties: { type: "number" },
  };
  expect(openaiSchema(constrained)).toEqual(constrained);
});
test("separate entrypoint provider errors retain classification", () => {
  const foreign = Object.assign(new Error("Rejected"), {
    name: "ProviderError",
    provider: "anthropic",
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    billingUnavailable: true,
    notSent: false,
    metadata: { message: "Your credit balance is too low" },
  });
  expect(isProviderError(foreign)).toBe(true);
  expect(ProviderError.from(foreign, "unknown").billingUnavailable).toBe(true);
  expect(
    isPermanentAIProviderFailure(
      new AIInputError(
        "capacity_unavailable",
        "Schema",
        400,
        undefined,
        fail("openai"),
      ),
    ),
  ).toBe(true);
  expect(
    isPermanentAIProviderFailure(
      new AIInputError("capacity_unavailable", "Busy", 503),
    ),
  ).toBe(false);
});
import { withResilience } from "../src/ai/resilience";
import { prepareAITextInputStep } from "../src/ai/prepareTextInput";
test("legacy document checkpoint survives enabling recovery and switching provider", async () => {
  const sections: string[] = [];
  let rejected = false;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 2400,
        maxOutputTokens: 100,
        contextWindowTokens: 2400,
      }),
      countTokens: async (params) => {
        if (rejected && params.model === "openai") throw fail("openai");
        return JSON.stringify(params).length;
      },
    },
    stream: async function* (params) {
      sections.push(
        JSON.parse(String(params.messages[0]!.content)).sourceSection,
      );
      yield { type: "text", content: "Known facts." };
      yield { type: "done" };
    },
  };
  const original = "A fact. ".repeat(1500);
  const params = {
    model: "openai",
    messages: [{ role: "user" as const, content: original }],
    maxTokens: 100,
  };
  const first = await prepareAITextInputStep(provider, params);
  expect(first.status).toBe("pending");
  if (first.status !== "pending") throw new Error("Expected checkpoint");
  rejected = true;
  await prepareAITextInput(provider, params, {
    checkpoint: first.checkpoint,
    providerFallback: { models: ["openai", "anthropic"] },
  });
  expect(sections.join("")).toBe(`user: ${original}`);
});
test("cancelled billing probe does not permanently suppress the provider", async () => {
  const originalNow = Date.now;
  let now = originalNow(),
    calls = 0;
  Date.now = () => now;
  try {
    const provider = withResilience(
      {
        stream: async function* () {
          calls++;
          if (calls === 1) throw fail("anthropic");
          if (calls === 2) throw new DOMException("Aborted", "AbortError");
          yield { type: "text", content: "Recovered" };
        },
      },
      "probe-fixture",
    );
    const params = { model: "test", messages: [] };
    await expect(collect(provider.stream(params))).rejects.toThrow();
    now += 300001;
    await expect(collect(provider.stream(params))).rejects.toThrow();
    expect(await collect(provider.stream(params))).toHaveLength(1);
    expect(calls).toBe(3);
  } finally {
    Date.now = originalNow;
  }
});
test("both unavailable stop after the two approved candidates", async () => {
  const calls: string[] = [];
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 1000,
        maxOutputTokens: 100,
        contextWindowTokens: 1100,
      }),
      countTokens: async (params) => {
        calls.push(params.model);
        throw fail(params.model);
      },
    },
    stream: async function* () {
      throw new Error("Must not generate");
    },
  };
  await expect(
    collect(
      streamWithAIContext(
        provider,
        { model: "openai", messages: [], maxTokens: 10 },
        { providerFallback: { models: ["anthropic", "openai"] } },
      ),
    ),
  ).rejects.toThrow();
  expect(calls).toEqual(["openai", "anthropic"]);
});
