import assert from "node:assert/strict";
import {
  createAIProviderRouter,
  prepareAITextInput,
  streamWithAIContext,
} from "../dist/ai/index.js";
import { anthropic } from "../dist/ai/providers/anthropic.js";
const unavailable = anthropic({
  apiKey: "fixture",
  fetch: async (url) =>
    String(url).includes("/models/")
      ? Response.json({ max_input_tokens: 10000, max_tokens: 1000 })
      : Response.json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "Your credit balance is too low to access the Anthropic API.",
            },
          },
          { status: 400 },
        ),
});
let counts = 0;
const provider = createAIProviderRouter({
  "claude-haiku-4-5-20251001": unavailable,
  alternate: {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 10000,
        maxOutputTokens: 1000,
        contextWindowTokens: 11000,
      }),
      countTokens: async () => {
        counts++;
        return 10;
      },
    },
    stream: async function* () {
      yield { type: "text", content: "Recovered" };
      yield { type: "done" };
    },
  },
});
const params = {
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: "Saved answer" }],
  maxTokens: 100,
};
const recovery = { models: ["alternate"] };
const prepared = await prepareAITextInput(provider, params, {
  providerFallback: recovery,
});
assert.equal(prepared.params.model, "alternate");
let result = "";
for await (const chunk of streamWithAIContext(provider, params, {
  providerFallback: recovery,
}))
  if (chunk.type === "text") result += chunk.content;
assert.equal(result, "Recovered");
assert.equal(counts, 2);
console.log("Built public entrypoints preserve preflight and billing recovery");
