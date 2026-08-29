import { describe, expect, test } from "bun:test";
import { generateAI } from "../src/ai/generateAI";
import { anthropic } from "../src/ai/providers/anthropic";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import type { AIChunk, AIProviderStreamParams } from "../types/ai";

const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}`;

const webSearchStream = (stopReason = "end_turn") =>
  [
    event("message_start", {
      message: { id: "msg-1", usage: { input_tokens: 12, output_tokens: 0 } },
    }),
    event("content_block_start", {
      content_block: {
        id: "srvtoolu-1",
        input: { query: "current event" },
        name: "web_search",
        type: "server_tool_use",
      },
    }),
    event("content_block_stop", {}),
    event("content_block_start", {
      content_block: {
        content: [
          {
            encrypted_content: "opaque",
            title: "Example",
            type: "web_search_result",
            url: "https://example.com/source",
          },
        ],
        tool_use_id: "srvtoolu-1",
        type: "web_search_tool_result",
      },
    }),
    event("content_block_stop", {}),
    event("content_block_delta", {
      delta: { text: "Grounded answer", type: "text_delta" },
    }),
    event("content_block_delta", {
      delta: {
        citation: {
          cited_text: "source text",
          title: "Example",
          type: "web_search_result_location",
          url: "https://example.com/source",
        },
        type: "citations_delta",
      },
    }),
    event("message_delta", {
      delta: { stop_reason: stopReason },
      usage: {
        output_tokens: 8,
        server_tool_use: { web_search_requests: 1 },
      },
    }),
    event("message_stop", {}),
    "",
  ].join("\n\n");

const drain = async (source: AsyncIterable<AIChunk>) => {
  const chunks: AIChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);

  return chunks;
};

const finalTextStream = () =>
  [
    event("message_start", {
      message: { id: "msg-2", usage: { input_tokens: 20, output_tokens: 0 } },
    }),
    event("content_block_delta", {
      delta: { text: "Finished after pause", type: "text_delta" },
    }),
    event("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    }),
    event("message_stop", {}),
    "",
  ].join("\n\n");

describe("Anthropic hosted tools", () => {
  test("requests native web search and normalizes citations + usage", async () => {
    let body: Record<string, unknown> = {};
    const provider = anthropic({
      apiKey: "test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(webSearchStream());
      }) as typeof fetch,
    });
    const chunks = await drain(
      provider.stream({
        messages: [{ content: "Search", role: "user" }],
        model: "claude-sonnet-4-6",
        providerOptions: {
          anthropic: {
            serverTools: [
              {
                parameters: {
                  allowedDomains: ["example.com"],
                  maxUses: 2,
                  userLocation: { country: "US", type: "approximate" },
                },
                type: "anthropic:web_search",
              },
            ],
          },
        },
      }),
    );

    expect(body.tools).toEqual([
      {
        allowed_domains: ["example.com"],
        max_uses: 2,
        name: "web_search",
        type: "web_search_20250305",
        user_location: { country: "US", type: "approximate" },
      },
    ]);
    expect(chunks).toContainEqual({
      content: "source text",
      title: "Example",
      type: "citation",
      url: "https://example.com/source",
    });
    expect(chunks.find((chunk) => chunk.type === "done")?.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      serverToolUse: { web_search_requests: 1 },
    });
  });

  test("rejects mutually exclusive domain filters", async () => {
    const provider = anthropic({
      apiKey: "test",
      fetch: (async () => new Response(webSearchStream())) as typeof fetch,
    });
    const params: AIProviderStreamParams = {
      messages: [{ content: "Search", role: "user" }],
      model: "claude-sonnet-4-6",
      providerOptions: {
        anthropic: {
          serverTools: [
            {
              parameters: {
                allowedDomains: ["example.com"],
                blockedDomains: ["other.example"],
              },
              type: "anthropic:web_search",
            },
          ],
        },
      },
    };

    await expect(drain(provider.stream(params))).rejects.toThrow(
      "allowedDomains or blockedDomains",
    );
  });

  test("generateAI returns hosted-search citations", async () => {
    const result = await generateAI({
      messages: [{ content: "Search", role: "user" }],
      model: "claude-sonnet-4-6",
      provider: anthropic({
        apiKey: "test",
        fetch: (async () => new Response(webSearchStream())) as typeof fetch,
      }),
      providerOptions: {
        anthropic: {
          serverTools: [{ type: "anthropic:web_search" }],
        },
      },
    });

    expect(result.text).toBe("Grounded answer");
    expect(result.citations).toEqual([
      {
        content: "source text",
        title: "Example",
        type: "citation",
        url: "https://example.com/source",
      },
    ]);
  });

  test("continues pause_turn with replayable hosted-tool blocks", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const provider = anthropic({
      apiKey: "test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        call += 1;

        return new Response(
          call === 1 ? webSearchStream("pause_turn") : finalTextStream(),
        );
      }) as typeof fetch,
    });

    let summary;
    for await (const item of streamAIWithTools({
      maxTurns: 3,
      messages: [{ content: "Search", role: "user" }],
      model: "claude-sonnet-4-6",
      provider,
      providerOptions: {
        anthropic: {
          serverTools: [{ type: "anthropic:web_search" }],
        },
      },
      tools: {},
    })) {
      if (item.type === "done") summary = item;
    }

    expect(call).toBe(2);
    expect(summary?.text).toContain("Finished after pause");
    expect(bodies[1]?.messages).toEqual([
      { content: "Search", role: "user" },
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: "server_tool_use" }),
          expect.objectContaining({ type: "web_search_tool_result" }),
        ]),
        role: "assistant",
      }),
    ]);
  });
});
