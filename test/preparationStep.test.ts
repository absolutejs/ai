import { expect, test } from "bun:test";
import {
  prepareAITextInput,
  prepareAITextInputStep,
  type AITextPreparationCheckpoint,
} from "../src/ai/prepareTextInput";
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
        content: "Budget: $17,431.29. Verify original evidence.",
      };
      yield { type: "done" };
    },
  };
  return { provider, calls: () => calls };
};
const params = {
  model: "test",
  maxTokens: 100,
  systemPrompt: "Extract intake facts",
  messages: [
    {
      role: "user" as const,
      content: "Original document information. ".repeat(1000),
    },
  ],
};

test("bounded steps reconstruct the same finished request after persisted restarts", async () => {
  const stepped = setup();
  let checkpoint: AITextPreparationCheckpoint | undefined;
  let finished = false;
  for (let step = 0; step < 100; step++) {
    const before = stepped.calls();
    const result = await prepareAITextInputStep(stepped.provider, params, {
      checkpoint,
    });
    expect(stepped.calls() - before).toBeLessThanOrEqual(1);
    if (result.status === "pending") {
      expect(result.checkpoint.processedCharacters).toBeGreaterThan(
        checkpoint?.processedCharacters ?? 0,
      );
      checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    } else {
      expect(stepped.calls() - before).toBe(0);
      const complete = setup();
      expect(result.prepared).toEqual(
        await prepareAITextInput(complete.provider, params),
      );
      expect(stepped.calls()).toBe(complete.calls());
      finished = true;
      break;
    }
  }
  expect(finished).toBe(true);
});

test("a fitting request is ready without preparation calls", async () => {
  const { provider, calls } = setup();
  const fitting = {
    ...params,
    messages: [{ role: "user" as const, content: "Hello" }],
  };
  const result = await prepareAITextInputStep(provider, fitting);
  expect(result.status).toBe("ready");
  if (result.status === "ready") expect(result.prepared.params).toBe(fitting);
  expect(calls()).toBe(0);
});

test("checkpoint persistence must succeed before a step can return pending", async () => {
  const { provider, calls } = setup();
  await expect(
    prepareAITextInputStep(provider, params, {
      onCheckpoint: async () => {
        throw new Error("attempt no longer owns this job");
      },
    }),
  ).rejects.toThrow("attempt no longer owns this job");
  expect(calls()).toBe(1);
});
