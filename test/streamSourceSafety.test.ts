import { expect, test } from "bun:test";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import type { AIProviderConfig } from "../types/ai";

test("a successful terminal tool stops generation and later tool side effects", async () => {
  let requests = 0;
  let sideEffects = 0;
  const provider: AIProviderConfig = {
    stream: async function* () {
      requests++;
      yield { type: "tool_use", id: "finish", name: "finish", input: {} };
      yield { type: "tool_use", id: "later", name: "later", input: {} };
      yield { type: "done" };
    },
  };
  const events = [];
  for await (const event of streamAIWithTools({
    provider,
    model: "test",
    messages: [],
    stopAfterTools: ["finish"],
    tools: {
      finish: {
        description: "finish",
        input: {},
        handler: () => "ready to save",
      },
      later: {
        description: "later",
        input: {},
        handler: () => {
          sideEffects++;
          return "done";
        },
      },
    },
  }))
    events.push(event);
  expect(requests).toBe(1);
  expect(sideEffects).toBe(0);
  expect(events.filter((event) => event.type === "tool_result")).toHaveLength(
    1,
  );
});

test("oversized tool results are detected before opening another provider request", async () => {
  let requests = 0;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({ maxInputTokens: 2000, maxOutputTokens: 100 }),
      countTokens: async (params) => JSON.stringify(params).length,
    },
    stream: async function* () {
      requests++;
      yield { type: "tool_use", id: "read", name: "read", input: {} };
      yield { type: "done" };
    },
  };
  const run = async () => {
    for await (const _event of streamAIWithTools({
      provider,
      model: "test",
      maxTokens: 100,
      validateInput: true,
      messages: [],
      tools: {
        read: {
          description: "read",
          input: {},
          handler: () => "x".repeat(3000),
        },
      },
    })) {
      /* consume */
    }
  };
  await expect(run()).rejects.toMatchObject({ code: "input_too_large" });
  expect(requests).toBe(1);
});

test("an interrupted validated stream cannot execute a terminal tool", async () => {
  let handled = 0;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({ maxInputTokens: 2000, maxOutputTokens: 100 }),
      countTokens: async () => 10,
    },
    stream: async function* () {
      yield { type: "tool_use", id: "finish", name: "finish", input: {} };
    },
  };
  const run = async () => {
    for await (const _event of streamAIWithTools({
      provider,
      model: "test",
      validateInput: true,
      stopAfterTools: ["finish"],
      messages: [],
      tools: {
        finish: {
          description: "finish",
          input: {},
          handler: () => {
            handled++;
            return "saved";
          },
        },
      },
    })) {
      /* consume */
    }
  };
  await expect(run()).rejects.toMatchObject({ code: "capacity_unavailable" });
  expect(handled).toBe(0);
});
