import { expect, test } from "bun:test";
import { anthropic } from "../src/ai/providers/anthropic";
import type { AIChunk } from "../types/ai";

const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}`;

// A write whose content is long, and whose text itself looks like a field.
const input = {
  content: `const note = { "path": "not-a-field" };\n${"x".repeat(5000)}`,
  path: "src/pages/Home.tsx",
};
const json = JSON.stringify({ path: input.path, content: input.content });
const pieces = json.match(/[\s\S]{1,700}/gu) ?? [];

const stream = () =>
  [
    event("message_start", {
      message: { id: "msg-1", usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    event("content_block_start", {
      content_block: {
        id: "toolu_1",
        input: {},
        name: "write_file",
        type: "tool_use",
      },
      index: 0,
    }),
    ...pieces.map((partial) =>
      event("content_block_delta", {
        delta: { partial_json: partial, type: "input_json_delta" },
        index: 0,
      }),
    ),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", {}),
  ].join("\n\n") + "\n\n";

test("a streaming tool input reports its progress and the fields already complete", async () => {
  const provider = anthropic({
    apiKey: "test",
    fetch: (async () => new Response(stream())) as unknown as typeof fetch,
  });
  const chunks: AIChunk[] = [];
  for await (const chunk of provider.stream({
    messages: [{ content: "write it", role: "user" }],
    model: "claude-sonnet-4-6",
  }))
    chunks.push(chunk);

  const progress = chunks.filter(
    (chunk): chunk is Extract<AIChunk, { type: "tool_input" }> =>
      chunk.type === "tool_input",
  );
  // Once at the start, then every 2 KB of input.
  expect(progress[0]).toEqual({
    fields: {},
    id: "toolu_1",
    name: "write_file",
    receivedChars: 0,
    type: "tool_input",
  });
  expect(progress.length).toBe(1 + Math.floor(json.length / 2048));
  for (const later of progress.slice(1)) {
    expect(later.fields).toEqual({ path: "src/pages/Home.tsx" });
    expect(later.receivedChars).toBeGreaterThan(0);
  }
  // The finished call is unchanged.
  const call = chunks.find((chunk) => chunk.type === "tool_use");
  expect(call).toMatchObject({ id: "toolu_1", input, name: "write_file" });
});
