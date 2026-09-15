import { expect, test } from "bun:test";
import {
  prepareAITextInput,
  type AITextPreparationCheckpoint,
} from "../src/ai/prepareTextInput";
import { inspectAIInput } from "../src/ai/inputCapacity";
import type { AIProviderConfig } from "../types/ai";

const setup = () => {
  let calls = 0;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 2400,
        contextWindowTokens: 2400,
        maxOutputTokens: 100,
      }),
      countTokens: async (params) => JSON.stringify(params).length,
    },
    stream: async function* () {
      calls++;
      yield {
        type: "text",
        content: "Budget is $17,431.29; verify the original correction.",
      };
      yield { type: "done" };
    },
  };
  return { provider, calls: () => calls };
};
const tools = [
  {
    name: "read_original",
    description: "Read original evidence. ".repeat(20),
    input_schema: { type: "object" },
  },
];
const compactedContext = {
  systemPrompt: "Verify exact facts in the original source. ".repeat(15),
  tools,
};

test("compaction budgets the actual final instructions and retrieval tools", async () => {
  const { provider } = setup();
  const source = "Long original intake fact. ".repeat(1000);
  const result = await prepareAITextInput(
    provider,
    {
      model: "test",
      maxTokens: 100,
      systemPrompt: "Complete intake",
      messages: [{ role: "user", content: source }],
    },
    { compactedContext },
  );
  expect(result.compacted).toBe(true);
  expect(result.params.tools).toEqual(tools);
  expect(result.params.systemPrompt).toBe(compactedContext.systemPrompt);
  expect((await inspectAIInput(provider, result.params)).fits).toBe(true);
});

test("impossible final tools fail before paying to summarize the source", async () => {
  const { provider, calls } = setup();
  await expect(
    prepareAITextInput(
      provider,
      {
        model: "test",
        maxTokens: 100,
        messages: [{ role: "user", content: "source ".repeat(1000) }],
      },
      { compactedContext: { systemPrompt: "instructions ".repeat(1000) } },
    ),
  ).rejects.toThrow("leave no room");
  expect(calls()).toBe(0);
});

test("a fitting request keeps its direct path without adding unused retrieval tools", async () => {
  const { provider, calls } = setup();
  const params = {
    model: "test",
    maxTokens: 100,
    messages: [{ role: "user" as const, content: "A short answer." }],
  };
  const result = await prepareAITextInput(provider, params, {
    compactedContext,
  });
  expect(result.compacted).toBe(false);
  expect(result.params).toBe(params);
  expect(calls()).toBe(0);
});

test("changing final retrieval instructions invalidates a saved preparation checkpoint", async () => {
  const { provider, calls } = setup();
  let checkpoint: AITextPreparationCheckpoint | undefined;
  const params = {
    model: "test",
    maxTokens: 100,
    messages: [{ role: "user" as const, content: "original ".repeat(1000) }],
  };
  await prepareAITextInput(provider, params, {
    compactedContext,
    onCheckpoint: (value) => {
      checkpoint = value;
    },
  });
  const completedCalls = calls();
  await prepareAITextInput(provider, params, { compactedContext, checkpoint });
  expect(calls()).toBe(completedCalls);
  await prepareAITextInput(provider, params, {
    compactedContext: {
      ...compactedContext,
      systemPrompt: "Check revised evidence requirements.",
    },
    checkpoint,
  });
  expect(calls()).toBeGreaterThan(completedCalls);
});
