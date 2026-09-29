import { testInputCapacity } from "./contextFixture";
import { describe, expect, test } from "bun:test";
import { generateAIWithTools } from "../src/ai/generateAI";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import { openaiResponses } from "../src/ai/providers/openaiResponses";
import type { AIChunk, AIProviderConfig } from "../types/ai";

const provider = (chunks: AIChunk[]): AIProviderConfig => ({
  inputCapacity: testInputCapacity,
  stream: () =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
});

const imageTurn: AIChunk[] = [
  { data: "cGFydA==", format: "png", isPartial: true, type: "image" },
  {
    data: "ZmluYWw=",
    format: "png",
    imageId: "ig_1",
    isPartial: false,
    revisedPrompt: "A red circle",
    type: "image",
  },
  { content: "Here it is.", type: "text" },
  { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
];

describe("generated images in the tool loops", () => {
  test("generateAIWithTools returns finished images", async () => {
    const result = await generateAIWithTools({
      messages: [{ content: "Draw a red circle", role: "user" }],
      model: "gpt-test",
      provider: provider(imageTurn),
      tools: {},
    });
    expect(result.text).toBe("Here it is.");
    expect(result.images).toEqual([
      {
        data: "ZmluYWw=",
        format: "png",
        imageId: "ig_1",
        isPartial: false,
        revisedPrompt: "A red circle",
      },
    ]);
  });

  test("streamAIWithTools yields previews and finished images", async () => {
    const events = [];
    for await (const event of streamAIWithTools({
      messages: [{ content: "Draw a red circle", role: "user" }],
      model: "gpt-test",
      provider: provider(imageTurn),
      tools: {},
    }))
      events.push(event);
    const images = events.filter((event) => event.type === "image");
    expect(images.map((image) => image.isPartial)).toEqual([true, false]);
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.images.length).toBe(1);
  });
});

describe("OpenAI Responses input files", () => {
  const sentContent = async (
    block: Record<string, unknown>,
  ): Promise<unknown> => {
    let body: { input?: { content?: unknown[] }[] } = {};
    const responses = openaiResponses({
      apiKey: "synthetic-test-key",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));

        return new Response(
          `event: response.completed\ndata: ${JSON.stringify({ response: {} })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    for await (const _chunk of responses.stream({
      messages: [{ content: [block as never], role: "user" }],
      model: "gpt-test",
    }));

    return body.input?.[0]?.content?.[0];
  };

  test("sends an image as a plain image_url string", async () => {
    expect(
      await sentContent({
        source: { data: "AAAA", media_type: "image/png", type: "base64" },
        type: "image",
      }),
    ).toEqual({
      detail: "auto",
      image_url: "data:image/png;base64,AAAA",
      type: "input_image",
    });
  });

  test("sends a PDF as file_data, or file_url for a link", async () => {
    expect(
      await sentContent({
        name: "invoice.pdf",
        source: { data: "AAAA", media_type: "application/pdf", type: "base64" },
        type: "document",
      }),
    ).toEqual({
      file_data: "data:application/pdf;base64,AAAA",
      filename: "invoice.pdf",
      type: "input_file",
    });
    expect(
      await sentContent({
        source: {
          media_type: "application/pdf",
          type: "url",
          url: "https://example.com/a.pdf",
        },
        type: "document",
      }),
    ).toEqual({ file_url: "https://example.com/a.pdf", type: "input_file" });
  });
});
