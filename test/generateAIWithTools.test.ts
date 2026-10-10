import { createUiCards, choiceCard } from "../src/ai/ui";
import { testInputCapacity } from "./contextFixture";
import { describe, expect, test } from "bun:test";
import { generateAIWithTools } from "../src/ai/generateAI";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../types/ai";

const scriptedProvider = (script: AIChunk[][]) => {
  const calls: AIProviderStreamParams[] = [];
  let index = 0;
  const provider: AIProviderConfig = {
    inputCapacity: testInputCapacity,
    stream(params) {
      calls.push(params);
      const chunks = script[Math.min(index, script.length - 1)]!;
      index += 1;

      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };

  return { calls, provider };
};

describe("generateAIWithTools", () => {
  test("executes the last allowed tool calls and forces a no-tools final answer", async () => {
    const { calls, provider } = scriptedProvider([
      [
        {
          id: "lookup-1",
          input: { company: "Acme" },
          name: "lookup",
          type: "tool_use",
        },
        { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
      ],
      [
        { content: "Verified result.", type: "text" },
        { type: "done", usage: { inputTokens: 4, outputTokens: 3 } },
      ],
    ]);
    const seen: unknown[] = [];
    const result = await generateAIWithTools({
      maxTurns: 1,
      messages: [{ content: "Research Acme", role: "user" }],
      model: "test-model",
      provider,
      tools: {
        lookup: {
          description: "lookup",
          handler: (input) => {
            seen.push(input);
            return "Acme evidence";
          },
          input: { type: "object" },
        },
      },
    });

    expect(seen).toEqual([{ company: "Acme" }]);
    expect(result.text).toBe("Verified result.");
    expect(result.stopReason).toBe("max_turns_finalized");
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 5 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.toolChoice).toBe("none");
    expect(calls[1]?.messages).toHaveLength(3);
  });

  test("does not add a synthesis turn when the model answers", async () => {
    const { calls, provider } = scriptedProvider([
      [
        { content: "Done.", type: "text" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const result = await generateAIWithTools({
      messages: [{ content: "go", role: "user" }],
      model: "test-model",
      provider,
      tools: {},
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

test("non-streaming card validation feeds failure back to the model for repair", async () => {
  const cards = createUiCards([choiceCard]);
  const valid = {
    title: "Which option?",
    options: [{ id: "one", label: "The complete option" }],
    submit: { tool: "reply_to_question", input: {}, label: "Send" },
  };
  const { calls, provider } = scriptedProvider([
    [
      {
        type: "tool_use",
        id: "invalid",
        name: "render_choice",
        input: { ...valid, options: [] },
      },
      { type: "done" },
    ],
    [
      { type: "tool_use", id: "repaired", name: "render_choice", input: valid },
      { type: "done" },
    ],
    [{ type: "text", content: "Choose an option above." }, { type: "done" }],
  ]);
  const result = await generateAIWithTools({
    messages: [{ role: "user", content: "Show my choices" }],
    model: "test-model",
    provider,
    tools: cards.tools,
  });
  expect(JSON.stringify(calls[1]?.messages)).toContain("was not rendered");
  expect(JSON.stringify(calls[1]?.messages)).not.toContain(choiceCard.ack);
  expect(JSON.stringify(calls[2]?.messages)).toContain(choiceCard.ack);
  expect(result.text).toBe("Choose an option above.");
  expect(cards.collect(result.toolCalls)).toEqual([
    { card: "render_choice", data: valid },
  ]);
});
