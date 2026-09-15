import { expect, test } from "bun:test";
import { createAITextSource } from "../src/ai/textSource";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import type { AIProviderConfig } from "../types/ai";

test("retrieves a precise middle fact omitted from notes, with original offsets and Unicode", () => {
  const original =
    "Intro. ".repeat(900) +
    "\nMálaga🙂: Orion's budget is exactly $17,431.29, not $20,000.\n" +
    "Appendix. ".repeat(900);
  const source = createAITextSource([{ role: "user", content: original }]);
  const [hit] = source.search("Orion budget");
  expect(hit).toBeDefined();
  expect(hit!.text).toContain("$17,431.29");
  expect(original.slice(hit!.start, hit!.end)).toBe(hit!.text);
  expect(source.read(hit!.sourceId, hit!.start).text).toContain("Málaga🙂");
  expect(source.search("unmentioned ZYXQ")).toEqual([]);
});

test("bounded, read-only source access cannot escape this conversation", async () => {
  const messages = [{ role: "user" as const, content: "🙂".repeat(10000) }];
  const source = createAITextSource(messages);
  const read = source.read("message_1", 1, 999999);
  expect(read.text.length).toBeLessThanOrEqual(6000);
  expect(read.text).not.toContain("\uFFFD");
  expect(() => source.read("other-member-source", 0)).toThrow();
  expect(() => source.read("message_1", -1)).toThrow();
  messages[0]!.content = "changed after indexing";
  expect(source.read("message_1").text).toStartWith("🙂");
  expect(
    await source.tools.search_text_source!.handler({
      query: "",
      sourceId: "other-member-source",
    }),
  ).toContain('"passages":[]');
});

test("a tool-using answer can recover exact facts absent from the supplied summary", async () => {
  const source = createAITextSource([
    {
      role: "user",
      content:
        "Background. ".repeat(900) +
        "\nOrion budget: $17,431.29; deadline: 23 November.\n" +
        "Other facts. ".repeat(900),
    },
  ]);
  let turns = 0;
  const provider: AIProviderConfig = {
    stream: async function* (params) {
      turns++;
      if (turns === 1) {
        yield {
          type: "tool_use",
          id: "search-1",
          name: "search_text_source",
          input: { query: "Orion budget" },
        };
      } else {
        const result = params.messages.at(-1)!.content;
        expect(JSON.stringify(result)).toContain("$17,431.29");
        expect(JSON.stringify(result)).toContain("23 November");
        yield {
          type: "text",
          content: "Verified in the original: $17,431.29; 23 November.",
        };
      }
      yield { type: "done" };
    },
  };
  let answer = "";
  for await (const event of streamAIWithTools({
    provider,
    model: "test",
    tools: source.tools,
    messages: [
      {
        role: "user",
        content:
          "Notes: Orion is a partner. What is their exact budget and deadline?",
      },
    ],
  })) {
    if (event.type === "text") answer += event.content;
  }
  expect(answer).toContain("$17,431.29");
  expect(turns).toBe(2);
});

test("an unpaired trailing surrogate cannot prevent source indexing from finishing", () => {
  const text = "A source ending in an unpaired surrogate: \ud800";
  const source = createAITextSource([{ role: "user", content: text }]);
  expect(source.read("message_1").text).toBe(text);
});
