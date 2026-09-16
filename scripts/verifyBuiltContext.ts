import assert from "node:assert/strict";
import { AIInputError, generateAI } from "../dist/ai/index.js";
import { anthropic } from "../dist/ai/providers/anthropic.js";

// Exercise separate public bundles, matching consumers' actual imports.
let calls = 0;
let recoveries = 0;
const original = "Original notes that are retained by the caller. ".repeat(8);
const provider = anthropic({
  apiKey: "fixture",
  fetch: async (url, init) => {
    const path = String(url);
    if (path.includes("/models/"))
      return Response.json({ max_input_tokens: 5000, max_tokens: 100 });
    if (path.includes("count_tokens"))
      return Response.json({ input_tokens: String(init?.body).length });
    calls++;
    if (calls === 1)
      return Response.json(
        {
          error: {
            type: "invalid_request_error",
            message: "prompt is too long: 5001 tokens > 5000 maximum",
          },
        },
        { status: 400 },
      );
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Done" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(
      events
        .map(
          ([event, data]) =>
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const result = await generateAI({
  provider,
  model: "fixture-model",
  maxTokens: 100,
  messages: [{ role: "user", content: original }],
  contextPolicy: {
    recover: async () => {
      recoveries++;
      return [{ role: "user", content: "Short" }];
    },
  },
});
assert.equal(result.text, "Done");
assert.equal(calls, 2);
assert.equal(recoveries, 1);
const unavailable = anthropic({
  apiKey: "fixture",
  fetch: async () =>
    Response.json({ max_input_tokens: null, max_tokens: 100, input_tokens: 1 }),
});
await assert.rejects(
  generateAI({ provider: unavailable, model: "unknown", messages: [] }),
  (error: unknown) =>
    error instanceof AIInputError && error.code === "capacity_unavailable",
);
console.log("Built AI/provider entrypoint context checks passed");
