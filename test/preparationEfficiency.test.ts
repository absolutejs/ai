import { expect, test } from "bun:test";
import { prepareAITextInput } from "../src/ai/prepareTextInput";
import type { AIProviderConfig, AIProviderStreamParams } from "../types/ai";

// The artificial tokenizer deliberately counts Unicode and JSON overhead. The
// model stub refuses any request the tokenizer has not checked successfully.
test("fuller sections reduce repeated notes while preserving all source bytes", async () => {
  const checked = new Set<string>();
  const sections: string[] = [];
  const budget = 4000;
  const original = "A🙂 factual correction. ".repeat(500);
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 8000,
        maxOutputTokens: 100,
        contextWindowTokens: 8100,
      }),
      countTokens: async (params) => {
        const serialized = JSON.stringify(params);
        if (serialized.length <= budget) checked.add(serialized);
        return serialized.length;
      },
    },
    stream: async function* (request) {
      expect(checked.has(JSON.stringify(request))).toBe(true);
      const section = JSON.parse(String(request.messages[0]!.content))
        .sourceSection as string;
      expect(section.isWellFormed()).toBe(true);
      sections.push(section);
      yield { type: "text", content: "Factual correction preserved." };
      yield { type: "done" };
    },
  };
  const params: AIProviderStreamParams = {
    model: "fixture",
    maxTokens: 100,
    messages: [{ role: "user", content: original }],
  };
  const result = await prepareAITextInput(provider, params, {
    contextBudget: { workingInputTokens: budget },
  });
  expect(result.compacted).toBe(true);
  expect(sections.join("")).toBe(`user: ${original}`);
  // This corpus needs five sections with full tokenizer-checked packing; the
  // former halving-only implementation takes six with the same provider.
  expect(sections.length).toBeLessThanOrEqual(5);
  expect(params.messages[0]!.content).toBe(original);
});

test("tokenizer cancellation during section refinement prevents generation", async () => {
  const controller = new AbortController();
  let calls = 0;
  let checks = 0;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 8000,
        maxOutputTokens: 100,
        contextWindowTokens: 8100,
      }),
      countTokens: async (params) => {
        checks++;
        if (checks === 6) controller.abort(new Error("cancel preparation"));
        return JSON.stringify(params).length;
      },
    },
    stream: async function* () {
      calls++;
      yield { type: "done" };
    },
  };
  await expect(
    prepareAITextInput(
      provider,
      {
        model: "fixture",
        maxTokens: 100,
        signal: controller.signal,
        messages: [{ role: "user", content: "x".repeat(12000) }],
      },
      { contextBudget: { workingInputTokens: 4000 } },
    ),
  ).rejects.toThrow("cancel preparation");
  expect(calls).toBe(0);
});

test("a preparation model uses its own capacity and leaves the final model unchanged", async () => {
  const sections: string[] = [];
  const generatedModels: string[] = [];
  const checked = new Set<string>();
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async (request) =>
        request.model === "notes"
          ? {
              maxInputTokens: 2400,
              maxOutputTokens: 80,
              contextWindowTokens: 2480,
            }
          : {
              maxInputTokens: 5000,
              maxOutputTokens: 200,
              contextWindowTokens: 5200,
            },
      countTokens: async (request) => {
        const text = JSON.stringify(request);
        const max = request.model === "notes" ? 2376 : 4950;
        if (text.length <= max) checked.add(text);
        return text.length;
      },
    },
    stream: async function* (request) {
      expect(request.model).toBe("notes");
      expect(request.maxTokens).toBeLessThanOrEqual(80);
      expect(checked.has(JSON.stringify(request))).toBe(true);
      generatedModels.push(request.model);
      sections.push(
        JSON.parse(String(request.messages[0]!.content)).sourceSection,
      );
      yield { type: "text", content: "Original facts preserved." };
      yield { type: "done" };
    },
  };
  const original = "Fact 🙂. ".repeat(900);
  const result = await prepareAITextInput(
    provider,
    {
      model: "answer",
      maxTokens: 200,
      messages: [{ role: "user", content: original }],
    },
    { preparationModel: "notes" },
  );
  expect(sections.join("")).toBe(`user: ${original}`);
  expect(generatedModels.length).toBeGreaterThan(1);
  expect(result.params.model).toBe("answer");
  expect(result.params.maxTokens).toBe(200);
});

test("changing the preparation model invalidates its saved notes", async () => {
  let checkpoint:
    | import("../src/ai/prepareTextInput").AITextPreparationCheckpoint
    | undefined;
  let calls = 0;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 4000,
        maxOutputTokens: 100,
        contextWindowTokens: 4100,
      }),
      countTokens: async (request) => JSON.stringify(request).length,
    },
    stream: async function* () {
      calls++;
      yield { type: "text", content: "Facts preserved." };
      yield { type: "done" };
    },
  };
  const params: AIProviderStreamParams = {
    model: "answer",
    maxTokens: 100,
    messages: [{ role: "user", content: "facts ".repeat(1500) }],
  };
  await prepareAITextInput(provider, params, {
    preparationModel: "notes-a",
    onCheckpoint: (saved) => {
      checkpoint = saved;
    },
  });
  const before = calls;
  await prepareAITextInput(provider, params, {
    preparationModel: "notes-a",
    checkpoint,
  });
  expect(calls).toBe(before);
  await prepareAITextInput(provider, params, {
    preparationModel: "notes-b",
    checkpoint,
  });
  expect(calls).toBeGreaterThan(before);
});
