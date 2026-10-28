import { expect, test } from "bun:test";
import { generateAIWithTools } from "../src/ai/generateAI";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import type { AIProviderConfig } from "../types/ai";
import { testInputCapacity } from "./contextFixture";

const fixture = () => {
  let requests = 0;
  let completed = 0;
  const provider: AIProviderConfig = {
    inputCapacity: testInputCapacity,
    stream: async function* () {
      requests += 1;
      yield { id: "lookup", input: {}, name: "lookup", type: "tool_use" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      completed += 1;
    },
  };
  return { provider, counts: () => ({ requests, completed }) };
};
const messages = [{ content: "Test", role: "user" as const }];

test("completed-turn observer can stop without dispatching tools or another provider call", async () => {
  const { provider, counts } = fixture();
  const stop = new AbortController();
  let toolCalls = 0;
  let observed = 0;
  await expect(
    generateAIWithTools({
      messages,
      model: "fixture",
      provider,
      signal: stop.signal,
      onTurn: (turn, usage) => {
        expect(counts().completed).toBe(1);
        expect(turn).toBe(1);
        expect(usage).toEqual({ inputTokens: 1, outputTokens: 1 });
        observed += 1;
        stop.abort(new Error("Stop between requests"));
      },
      tools: {
        lookup: {
          description: "Lookup",
          input: { type: "object" },
          handler: () => {
            toolCalls += 1;
            return "Found";
          },
        },
      },
    }),
  ).rejects.toThrow("Stop between requests");
  expect(counts()).toEqual({ requests: 1, completed: 1 });
  expect(observed).toBe(1);
  expect(toolCalls).toBe(0);
});

for (const maxTurns of [1, 3]) {
  test(`cancellation after tools prevents the next provider request with maxTurns=${maxTurns}`, async () => {
    const { provider, counts } = fixture();
    const stop = new AbortController();
    await expect(
      generateAIWithTools({
        messages,
        model: "fixture",
        provider,
        maxTurns,
        signal: stop.signal,
        tools: {
          lookup: {
            description: "Lookup",
            input: { type: "object" },
            handler: () => {
              stop.abort(new Error("Tools complete"));
              return "Found";
            },
          },
        },
      }),
    ).rejects.toThrow("Tools complete");
    expect(counts()).toEqual({ requests: 1, completed: 1 });
  });
}

test("pre-cancelled generation never starts a provider", async () => {
  const { provider, counts } = fixture();
  await expect(
    generateAIWithTools({
      messages,
      model: "fixture",
      provider,
      signal: AbortSignal.abort(new Error("Already stopped")),
      tools: {},
    }),
  ).rejects.toThrow("Already stopped");
  expect(counts().requests).toBe(0);
});

test("streaming cancellation after tools prevents forced final synthesis", async () => {
  const { provider, counts } = fixture();
  const stop = new AbortController();
  const run = async () => {
    for await (const _event of streamAIWithTools({
      messages,
      model: "fixture",
      provider,
      maxTurns: 1,
      signal: stop.signal,
      tools: {
        lookup: {
          description: "Lookup",
          input: { type: "object" },
          handler: () => {
            stop.abort(new Error("Tools complete"));
            return "Found";
          },
        },
      },
    })) {
    }
  };
  await expect(run()).rejects.toThrow("Tools complete");
  expect(counts()).toEqual({ requests: 1, completed: 1 });
});
