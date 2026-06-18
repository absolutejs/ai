import { afterEach, describe, expect, test } from "bun:test";
import { anthropic } from "../src/ai/providers/anthropic";
import { resolveRenderers } from "../src/ai/htmxRenderers";
import { streamAIToSSE } from "../src/ai/streamAIToSSE";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../types/ai";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sseBody = (events: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      controller.close();
    },
  });

// Stream that emits planning text then ends with stop_reason=max_tokens while a
// tool_use block is still open (no content_block_stop) — the production bug.
const TRUNCATED_SSE = [
  `event: message_start\ndata: ${JSON.stringify({
    message: { usage: { input_tokens: 5, output_tokens: 0 } },
    type: "message_start",
  })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    content_block: { text: "", type: "text" },
    index: 0,
    type: "content_block_start",
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    delta: { text: "Planning the files...", type: "text_delta" },
    index: 0,
    type: "content_block_delta",
  })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    content_block: { id: "toolu_1", input: {}, name: "write_file", type: "tool_use" },
    index: 1,
    type: "content_block_start",
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    delta: { partial_json: '{"path":"a.ts","content":"', type: "input_json_delta" },
    index: 1,
    type: "content_block_delta",
  })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    delta: { stop_reason: "max_tokens" },
    type: "message_delta",
    usage: { output_tokens: 200 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const drain = async (iter: AsyncIterable<AIChunk>) => {
  const out: AIChunk[] = [];
  for await (const chunk of iter) out.push(chunk);

  return out;
};

describe("anthropic SSE parser: stop_reason capture", () => {
  test("propagates stop_reason=max_tokens onto the done chunk", async () => {
    globalThis.fetch = (async () =>
      ({
        body: sseBody(TRUNCATED_SSE),
        ok: true,
        status: 200,
      }) as Response) as typeof fetch;

    const provider = anthropic({ apiKey: "test", baseUrl: "http://localhost" });
    const chunks = await drain(
      provider.stream({
        messages: [{ content: "build me an app", role: "user" }],
        model: "claude-sonnet-4-6",
      } as AIProviderStreamParams),
    );

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    expect(done?.type === "done" && done.stopReason).toBe("max_tokens");
  });
});

// Fake provider mirroring the truncated stream at the chunk level — drives
// streamTurns without any network. Yields planning text then a done chunk
// carrying stopReason, and NO tool_use chunk (the block never closed).
const truncatedProvider: AIProviderConfig = {
  stream: () =>
    (async function* () {
      yield { content: "Planning the files...", type: "text" } as AIChunk;
      yield {
        stopReason: "max_tokens",
        type: "done",
        usage: { inputTokens: 5, outputTokens: 200 },
      } as AIChunk;
    })(),
};

const cleanProvider: AIProviderConfig = {
  stream: () =>
    (async function* () {
      yield { content: "All done.", type: "text" } as AIChunk;
      yield {
        type: "done",
        usage: { inputTokens: 5, outputTokens: 12 },
      } as AIChunk;
    })(),
};

describe("streamAIToSSE: max_tokens truncation surfaces a status error", () => {
  test("yields a status event explaining the truncation", async () => {
    const renderers = resolveRenderers();
    const events: Array<{ data: string; event: string }> = [];
    for await (const evt of streamAIToSSE(
      "conv-1",
      "msg-1",
      { model: "claude-sonnet-4-6", provider: truncatedProvider },
      renderers,
    )) {
      events.push(evt);
    }

    const status = events.find(
      (e) => e.event === "status" && e.data.includes("Response truncated at max_tokens"),
    );
    expect(status).toBeDefined();
    expect(status?.data).toContain("output=200");
    // The truncation branch returns early — no normal completion is emitted.
    expect(events.filter((e) => e.event === "status")).toHaveLength(1);
  });

  test("a clean stop_reason still completes normally", async () => {
    const renderers = resolveRenderers();
    const events: Array<{ data: string; event: string }> = [];
    for await (const evt of streamAIToSSE(
      "conv-2",
      "msg-2",
      { model: "claude-sonnet-4-6", provider: cleanProvider },
      renderers,
    )) {
      events.push(evt);
    }

    expect(
      events.some((e) => e.data.includes("Response truncated at max_tokens")),
    ).toBe(false);
  });
});
