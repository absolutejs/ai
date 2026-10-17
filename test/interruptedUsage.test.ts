import { expect, test } from "bun:test";
import { anthropic } from "../src/ai/providers/anthropic";
import { openai } from "../src/ai/providers/openai";
import { openaiResponses } from "../src/ai/providers/openaiResponses";
import type { AIChunk } from "../types/ai";

const params = {
  model: "fixture",
  messages: [{ role: "user" as const, content: "fixture" }],
  maxRetries: 0,
};
const event = (type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = event("message_start", {
  message: {
    id: "msg-fixture",
    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20 },
  },
});
const delta = event("message_delta", { usage: { output_tokens: 15 } });
const transport = (body: string) => async () =>
  new Response(body, { headers: { "Content-Type": "text/event-stream" } });

test("Anthropic exposes cumulative snapshots before a same-frame error without inventing final usage", async () => {
  const provider = anthropic({
    apiKey: "fixture",
    providerName: "usage-test",
    fetch: transport(
      start +
        delta +
        event("error", {
          error: { type: "overloaded_error", message: "interrupted" },
        }),
    ),
  });
  const chunks: AIChunk[] = [];
  await expect(
    (async () => {
      for await (const chunk of provider.stream(params)) chunks.push(chunk);
    })(),
  ).rejects.toThrow("interrupted");
  const updates = chunks.filter((chunk) => chunk.type === "usage_update");
  expect(updates.map((chunk) => chunk.usage.outputTokens)).toEqual([1, 15]);
  expect(updates.every((chunk) => chunk.final === false)).toBe(true);
  expect(updates[1]?.usage.inputTokens).toBe(100);
  expect(updates[1]?.usage.cacheReadInputTokens).toBe(20);
  expect(updates[0]?.metadata?.generationId).toBe("msg-fixture");
  expect(chunks.some((chunk) => chunk.type === "done")).toBe(false);
});

test("Anthropic EOF cannot turn partial usage into a completed bill", async () => {
  const provider = anthropic({
    apiKey: "fixture",
    providerName: "usage-eof",
    fetch: transport(start + delta),
  });
  const chunks: AIChunk[] = [];
  for await (const chunk of provider.stream(params)) chunks.push(chunk);
  expect(chunks.filter((chunk) => chunk.type === "usage_update")).toHaveLength(
    2,
  );
  expect(chunks.some((chunk) => chunk.type === "done")).toBe(false);
});

test("Anthropic successful final usage replaces snapshots, rather than summing them", async () => {
  const provider = anthropic({
    apiKey: "fixture",
    providerName: "usage-success",
    fetch: transport(start + delta + event("message_stop", {})),
  });
  const chunks: AIChunk[] = [];
  for await (const chunk of provider.stream(params)) chunks.push(chunk);
  expect(
    chunks.find((chunk) => chunk.type === "done")?.usage?.outputTokens,
  ).toBe(15);
});

test("OpenAI exposes provider final usage even if the following stream event fails", async () => {
  const body = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 15 }, id: "chat-fixture" })}\n\ndata: ${JSON.stringify({ error: { message: "lost stream", code: 500 } })}\n\n`;
  const provider = openai({
    apiKey: "fixture",
    providerName: "usage-openai",
    fetch: transport(body),
  });
  const chunks: AIChunk[] = [];
  await expect(
    (async () => {
      for await (const chunk of provider.stream(params)) chunks.push(chunk);
    })(),
  ).rejects.toThrow("lost stream");
  expect(chunks[0]).toMatchObject({
    type: "usage_update",
    final: true,
    usage: { inputTokens: 100, outputTokens: 15 },
  });
});

test("Responses preserves usage from an incomplete response without claiming finality", async () => {
  const provider = openaiResponses({
    apiKey: "fixture",
    providerName: "usage-responses",
    fetch: transport(
      event("response.incomplete", {
        response: {
          id: "resp-fixture",
          usage: { input_tokens: 100, output_tokens: 15 },
        },
      }),
    ),
  });
  const chunks: AIChunk[] = [];
  await expect(
    (async () => {
      for await (const chunk of provider.stream(params)) chunks.push(chunk);
    })(),
  ).rejects.toThrow();
  expect(chunks[0]).toMatchObject({
    type: "usage_update",
    final: false,
    usage: { inputTokens: 100, outputTokens: 15 },
  });
});

test("tool-input start events remain available across the three cloud adapters", async () => {
  const fixtures = [
    anthropic({
      apiKey: "fixture",
      providerName: "progress-anthropic",
      fetch: transport(
        event("content_block_start", {
          content_block: {
            type: "tool_use",
            id: "tool-fixture",
            name: "render_choice",
          },
        }) + event("message_stop", {}),
      ),
    }),
    openai({
      apiKey: "fixture",
      providerName: "progress-chat",
      fetch: transport(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tool-fixture", function: { name: "render_choice", arguments: "{}" } }] } }] })}\n\ndata: [DONE]\n\n`,
      ),
    }),
    openaiResponses({
      apiKey: "fixture",
      providerName: "progress-responses",
      fetch: transport(
        event("response.output_item.added", {
          item: {
            type: "function_call",
            id: "item-fixture",
            call_id: "tool-fixture",
            name: "render_choice",
          },
        }) + event("response.completed", { response: {} }),
      ),
    }),
  ];
  for (const provider of fixtures) {
    const chunks: AIChunk[] = [];
    for await (const chunk of provider.stream(params)) chunks.push(chunk);
    expect(
      chunks.find((chunk) => chunk.type === "tool_input_start"),
    ).toMatchObject({ id: "tool-fixture", name: "render_choice" });
  }
});
