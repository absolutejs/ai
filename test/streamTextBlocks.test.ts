import { testInputCapacity } from "./contextFixture";
import { expect, test } from "bun:test";
import { resolveRenderers } from "../src/ai/htmxRenderers";
import { streamAIToSSE } from "../src/ai/streamAIToSSE";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderMessage,
  AIProviderStreamParams,
} from "../types/ai";

// Anthropic finds the previous request's cache entry only within 20 blocks, so
// the history a tool loop sends back must hold a turn's text as one block.
test("a turn's streamed text goes back to the provider as one block per run", async () => {
  const requests: AIProviderMessage[][] = [];
  let call = 0;
  const provider: AIProviderConfig = {
    inputCapacity: testInputCapacity,
    stream: (params: AIProviderStreamParams) => {
      requests.push(structuredClone(params.messages));
      const turn = call++;

      return (async function* () {
        if (turn === 0) {
          for (const piece of ["Reading ", "the ", "page ", "first."])
            yield { content: piece, type: "text" } as AIChunk;
          yield {
            id: "toolu_1",
            input: { path: "a" },
            name: "probe",
            type: "tool_use",
          } as AIChunk;
          for (const piece of ["Then ", "again."])
            yield { content: piece, type: "text" } as AIChunk;
          yield {
            id: "toolu_2",
            input: { path: "b" },
            name: "probe",
            type: "tool_use",
          } as AIChunk;
        } else {
          yield { content: "done", type: "text" } as AIChunk;
        }
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as AIChunk;
      })();
    },
  };

  for await (const _event of streamAIToSSE(
    "c",
    "m",
    {
      messages: [{ content: "copy it", role: "user" }],
      model: "claude-sonnet-4-6",
      provider,
      structuredEvents: true,
      tools: {
        probe: {
          description: "probe",
          handler: () => "ok",
          input: { type: "object" },
        },
      },
    },
    resolveRenderers(),
  )) {
    // drain
  }

  const assistant = requests[1]?.find(
    (message) => message.role === "assistant",
  );
  expect(Array.isArray(assistant?.content)).toBe(true);
  const blocks = assistant?.content as Array<{
    type: string;
    content?: string;
  }>;
  expect(blocks.map((block) => block.type)).toEqual([
    "text",
    "tool_use",
    "text",
    "tool_use",
  ]);
  expect(blocks[0]?.content).toBe("Reading the page first.");
  expect(blocks[2]?.content).toBe("Then again.");
});
