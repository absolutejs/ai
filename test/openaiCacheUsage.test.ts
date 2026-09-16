import { expect, test } from "bun:test";
import { openai } from "../src/ai/providers/openai";
import { openaiResponses } from "../src/ai/providers/openaiResponses";

for (const responses of [false, true]) {
  for (const writes of [0, 200]) {
    test(`${responses ? "Responses" : "Chat"} excludes ${writes} cache-write tokens from ordinary input`, async () => {
      const details = { cached_tokens: 300, cache_write_tokens: writes };
      const usage = responses
        ? {
            input_tokens: 1000,
            output_tokens: 40,
            input_tokens_details: details,
          }
        : {
            prompt_tokens: 1000,
            completion_tokens: 40,
            prompt_tokens_details: details,
          };
      const body = responses
        ? `event: response.completed\ndata: ${JSON.stringify({ response: { usage } })}\n\n`
        : `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
      const provider = (responses ? openaiResponses : openai)({
        apiKey: "synthetic-test-key",
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      });
      const chunks = [];
      for await (const chunk of provider.stream({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "Synthetic usage test" }],
      }))
        chunks.push(chunk);
      const done = chunks.find((chunk) => chunk.type === "done");
      expect(done?.usage?.inputTokens).toBe(700 - writes);
      expect(done?.usage?.cacheReadInputTokens).toBe(300);
      expect(done?.usage?.cacheWriteInputTokens ?? 0).toBe(writes);
      expect(done?.usage?.outputTokens).toBe(40);
      expect(
        (done?.usage?.inputTokens ?? 0) +
          (done?.usage?.cacheReadInputTokens ?? 0) +
          (done?.usage?.cacheWriteInputTokens ?? 0),
      ).toBe(1000);
    });
  }
}
