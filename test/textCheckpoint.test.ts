import { expect, test } from "bun:test";
import {
  prepareAITextInput,
  type AITextPreparationCheckpoint,
} from "../src/ai/prepareTextInput";
import type { AIProviderConfig } from "../types/ai";

test("an interrupted ingestion resumes after its last completed section without rereading it", async () => {
  let checkpoint: AITextPreparationCheckpoint | undefined;
  let calls = 0;
  let fail = true;
  const sections: string[] = [];
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 2400,
        maxOutputTokens: 100,
        contextWindowTokens: 2400,
      }),
      countTokens: async (params) => {
        expect(params.messages.length).toBeGreaterThan(0);
        return JSON.stringify(params).length;
      },
    },
    stream: async function* (params) {
      calls++;
      if (fail && calls === 2) throw new Error("connection lost");
      sections.push(
        JSON.parse(String(params.messages[0]!.content)).sourceSection,
      );
      yield { type: "text", content: "Known facts and corrections." };
      yield { type: "done" };
    },
  };
  const original = "A🙂 fact. ".repeat(1700);
  const params = {
    model: "test",
    maxTokens: 100,
    messages: [{ role: "user" as const, content: original }],
  };
  await expect(
    prepareAITextInput(provider, params, {
      onCheckpoint: (value) => {
        checkpoint = value;
      },
    }),
  ).rejects.toThrow("connection lost");
  expect(checkpoint!.processedCharacters).toBeGreaterThan(0);
  fail = false;
  const resumed = await prepareAITextInput(provider, params, {
    checkpoint,
    onCheckpoint: (value) => {
      checkpoint = value;
    },
  });
  expect(resumed.compacted).toBe(true);
  expect(sections.join("")).toBe(`user: ${original}`);
  expect(params.messages[0]!.content).toBe(original);
  const before = calls;
  await prepareAITextInput(provider, params, { checkpoint });
  expect(calls).toBe(before);
  // Editing an earlier fact invalidates the prefix fingerprint.
  await prepareAITextInput(
    provider,
    { ...params, messages: [{ role: "user", content: "Changed " + original }] },
    { checkpoint },
  );
  expect(calls).toBeGreaterThan(before);
  const afterEdit = calls;
  await prepareAITextInput(
    provider,
    { ...params, systemPrompt: "A different task" },
    { checkpoint },
  );
  expect(calls).toBeGreaterThan(afterEdit);
});
