import { expect, test } from "bun:test";
import { openai } from "../src/ai/providers/openai";
import type { AIProviderMessage } from "../types/ai";

test("OpenAI preserves parallel tool results followed by later tool turns", async () => {
  let sent: Record<string, unknown> | undefined;
  const provider = openai({
    apiKey: "synthetic-test-key",
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const messages: AIProviderMessage[] = [
    { role: "user", content: "Read both sources, then verify." },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-a",
          name: "read",
          input: { source: "a" },
        },
        {
          type: "tool_use",
          id: "read-b",
          name: "read",
          input: { source: "b" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "read-a",
          content: "first original",
        },
        {
          type: "tool_result",
          tool_use_id: "read-b",
          content: "second original",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "verify-c", name: "verify", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "verify-c", content: "verified" },
      ],
    },
    { role: "user", content: "Finish with both originals." },
  ];
  const before = structuredClone(messages);
  for await (const _chunk of provider.stream({
    model: "gpt-4.1",
    messages,
    systemPrompt: "Use the supplied originals.",
  })) {
    // Consume the synthetic stream to capture the actual HTTP request.
  }
  expect(sent?.messages).toEqual([
    { role: "system", content: "Use the supplied originals." },
    { role: "user", content: "Read both sources, then verify." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          type: "function",
          id: "read-a",
          function: { name: "read", arguments: '{"source":"a"}' },
        },
        {
          type: "function",
          id: "read-b",
          function: { name: "read", arguments: '{"source":"b"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "read-a", content: "first original" },
    { role: "tool", tool_call_id: "read-b", content: "second original" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          type: "function",
          id: "verify-c",
          function: { name: "verify", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "verify-c", content: "verified" },
    { role: "user", content: "Finish with both originals." },
  ]);
  expect(messages).toEqual(before);
});
