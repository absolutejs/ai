// Optional live regression: requires ANTHROPIC_API_KEY and uses synthetic data only.
// Deliberately simulate a 6k context to exercise ingestion with the real tokenizer.
import { anthropic } from "../src/ai/providers/anthropic";
import { prepareAITextInput } from "../src/ai/prepareTextInput";
import { createAITextSource } from "../src/ai/textSource";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
const raw = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
let inputTokens = 0,
  outputTokens = 0;
const provider = {
  ...raw,
  inputCapacity: {
    ...raw.inputCapacity!,
    getLimits: async () => ({
      maxInputTokens: 6000,
      contextWindowTokens: 6000,
      maxOutputTokens: 1024,
    }),
  },
  stream: async function* (params: Parameters<typeof raw.stream>[0]) {
    for await (const chunk of raw.stream(params)) {
      if (chunk.type === "done" && chunk.usage) {
        inputTokens += chunk.usage.inputTokens;
        outputTokens += chunk.usage.outputTokens;
      }
      yield chunk;
    }
  },
};
const filler =
  "Routine background: the team reviews partner proposals weekly and maintains meeting notes.\n";
const original =
  "Orion initial budget: $20,000; initial deadline: 23 November.\n" +
  filler.repeat(650) +
  "\nFINAL CORRECTION for Orion: the approved budget is exactly $17,431.29 and the deadline is 26 November. The earlier budget and deadline are superseded.\n" +
  filler.repeat(250);
const messages = [{ role: "user" as const, content: original }];
const source = createAITextSource(messages);
const prepared = await prepareAITextInput(provider, {
  model: "claude-opus-4-6",
  maxTokens: 1024,
  signal: AbortSignal.timeout(180000),
  systemPrompt:
    "Help complete a business intake. Preserve corrections to numbers and dates. Originals remain searchable.",
  messages,
});
if (!prepared.compacted)
  throw new Error("Test did not exercise oversized ingestion");
// Deliberately omit the correction from the notes, simulating a lossy summary.
let answer = "",
  lookups = 0;
for await (const event of streamAIWithTools({
  provider,
  model: "claude-opus-4-6",
  maxTokens: 1024,
  maxTurns: 4,
  validateInput: true,
  signal: AbortSignal.timeout(120000),
  tools: source.tools,
  systemPrompt:
    "Answer from the original saved text. The notes can omit corrections. You MUST search the original source to verify the current budget and deadline. Return only the corrected budget and deadline, with a short exact quote as evidence.",
  messages: [
    {
      role: "user",
      content:
        "Notes: Orion initially had a $20,000 budget and 23 November deadline; more source details are omitted. What are the CURRENT approved budget and deadline?",
    },
  ],
})) {
  if (event.type === "text") answer += event.content;
  if (event.type === "tool_result" && event.ok) lookups++;
}
console.log(
  JSON.stringify({
    sections: prepared.sectionsProcessed,
    sourceLookups: lookups,
    inputTokens,
    outputTokens,
    answer,
  }),
);
if (
  !lookups ||
  !answer.includes("17,431.29") ||
  !answer.includes("26 November")
)
  throw new Error("Exact corrected facts were not recovered");
