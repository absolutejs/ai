import { describe, expect, test } from "bun:test";
import { parseProviderProxyParams } from "../src/ai/providerProxy";
import {
  anthropic,
  CONTEXT_MANAGEMENT_BETA,
} from "../src/ai/providers/anthropic";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import type { AIChunk, AIProviderStreamParams } from "../types/ai";

const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}`;

const textStream = (text: string) =>
  [
    event("message_start", {
      message: { id: "msg", usage: { input_tokens: 10, output_tokens: 0 } },
    }),
    event("content_block_delta", { delta: { text, type: "text_delta" } }),
    event("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    }),
    event("message_stop", {}),
    "",
  ].join("\n\n");

/* The model searches the deferred tools, finds one and calls it. */
const searchThenCallStream = () =>
  [
    event("message_start", {
      message: { id: "msg-1", usage: { input_tokens: 10, output_tokens: 0 } },
    }),
    event("content_block_start", {
      content_block: {
        id: "srvtoolu_1",
        input: {},
        name: "tool_search_tool_bm25",
        type: "server_tool_use",
      },
    }),
    event("content_block_delta", {
      delta: { partial_json: '{"query":"database"}', type: "input_json_delta" },
    }),
    event("content_block_stop", {}),
    event("content_block_start", {
      content_block: {
        content: {
          tool_references: [
            { tool_name: "prepare_database", type: "tool_reference" },
          ],
          type: "tool_search_tool_search_result",
        },
        tool_use_id: "srvtoolu_1",
        type: "tool_search_tool_result",
      },
    }),
    event("content_block_stop", {}),
    event("content_block_start", {
      content_block: {
        id: "toolu_1",
        input: {},
        name: "prepare_database",
        type: "tool_use",
      },
    }),
    event("content_block_delta", {
      delta: {
        partial_json: '{"engine":"postgres"}',
        type: "input_json_delta",
      },
    }),
    event("content_block_stop", {}),
    event("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 20 },
    }),
    event("message_stop", {}),
    "",
  ].join("\n\n");

const drain = async (source: AsyncIterable<AIChunk>) => {
  const chunks: AIChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);

  return chunks;
};

const capture = (respond: (call: number) => string) => {
  const requests: { body: Record<string, any>; headers: Headers }[] = [];
  const provider = anthropic({
    apiKey: "test",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });

      return new Response(respond(requests.length));
    }) as typeof fetch,
  });

  return { provider, requests };
};

const schema = { properties: {}, type: "object" };

describe("deferred tools", () => {
  test("load on demand through tool search, with the cache on a loaded tool", async () => {
    const { provider, requests } = capture(() => textStream("ok"));
    await drain(
      provider.stream({
        messages: [{ content: "Build it", role: "user" }],
        model: "claude-sonnet-4-6",
        tools: [
          { description: "Write a file", input_schema: schema, name: "write" },
          {
            deferLoading: true,
            description: "Set up a database",
            input_schema: schema,
            name: "prepare_database",
          },
        ],
      }),
    );

    expect(requests[0]?.body.tools).toEqual([
      {
        cache_control: { type: "ephemeral" },
        description: "Write a file",
        input_schema: schema,
        name: "write",
      },
      {
        defer_loading: true,
        description: "Set up a database",
        input_schema: schema,
        name: "prepare_database",
      },
      { name: "tool_search_tool_bm25", type: "tool_search_tool_bm25_20251119" },
    ]);
  });

  test("leave a request without deferred tools exactly as before", async () => {
    const { provider, requests } = capture(() => textStream("ok"));
    await drain(
      provider.stream({
        messages: [{ content: "Build it", role: "user" }],
        model: "claude-sonnet-4-6",
        tools: [
          { description: "Write a file", input_schema: schema, name: "write" },
        ],
      }),
    );

    expect(requests[0]?.body.tools).toEqual([
      {
        cache_control: { type: "ephemeral" },
        description: "Write a file",
        input_schema: schema,
        name: "write",
      },
    ]);
  });

  test("replay the search unchanged and answer only the client tool", async () => {
    const { provider, requests } = capture((call) =>
      call === 1 ? searchThenCallStream() : textStream("Database ready"),
    );
    const ran: unknown[] = [];
    let summary;
    for await (const item of streamAIWithTools({
      contextPolicy: false,
      maxTurns: 3,
      messages: [{ content: "Add a database", role: "user" }],
      model: "claude-sonnet-4-6",
      provider,
      tools: {
        prepare_database: {
          deferLoading: true,
          description: "Set up a database",
          handler: (input) => {
            ran.push(input);

            return "prepared";
          },
          input: schema,
        },
        write: {
          description: "Write a file",
          handler: () => "written",
          input: schema,
        },
      },
    })) {
      if (item.type === "done") summary = item;
    }

    expect(ran).toEqual([{ engine: "postgres" }]);
    expect(summary?.text).toContain("Database ready");
    const [, assistant, results] = requests[1]?.body.messages ?? [];
    expect(assistant.content).toEqual(
      expect.arrayContaining([
        {
          id: "srvtoolu_1",
          input: { query: "database" },
          name: "tool_search_tool_bm25",
          type: "server_tool_use",
        },
        expect.objectContaining({
          tool_use_id: "srvtoolu_1",
          type: "tool_search_tool_result",
        }),
      ]),
    );
    // The search is the API's own; only the discovered tool gets a result.
    const answered = results.content
      .filter((block: { type: string }) => block.type === "tool_result")
      .map((block: { tool_use_id: string }) => block.tool_use_id);
    expect(answered).toEqual(["toolu_1"]);
    // The same tool list, deferred definitions included, on every request.
    expect(
      requests[0]?.body.tools.map(
        (tool: { defer_loading?: boolean; name: string }) =>
          `${tool.name}${tool.defer_loading ? " (deferred)" : ""}`,
      ),
    ).toEqual([
      "prepare_database (deferred)",
      "write",
      "tool_search_tool_bm25",
    ]);
    expect(requests[1]?.body.tools).toEqual(requests[0]?.body.tools);
  });
});

describe("clearing old tool results", () => {
  test("asks Anthropic to clear past a threshold, with its beta header kept alongside others", async () => {
    const requests: { body: Record<string, any>; headers: Headers }[] = [];
    const provider = anthropic({
      apiKey: "test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });

        return new Response(textStream("ok"));
      }) as typeof fetch,
      headers: { "anthropic-beta": "other-beta-2026-01-01" },
    });
    await drain(
      provider.stream({
        messages: [{ content: "Build it", role: "user" }],
        model: "claude-sonnet-4-6",
        toolResultClearing: {
          clearAtLeastInputTokens: 40_000,
          excludeTools: ["render_plan"],
          keepToolUses: 4,
          triggerInputTokens: 100_000,
        },
      }),
    );

    expect(requests[0]?.body.context_management).toEqual({
      edits: [
        {
          clear_at_least: { type: "input_tokens", value: 40_000 },
          exclude_tools: ["render_plan"],
          keep: { type: "tool_uses", value: 4 },
          trigger: { type: "input_tokens", value: 100_000 },
          type: "clear_tool_uses_20250919",
        },
      ],
    });
    expect(requests[0]?.headers.get("anthropic-beta")).toBe(
      `other-beta-2026-01-01,${CONTEXT_MANAGEMENT_BETA}`,
    );
  });

  test("sends neither without being asked", async () => {
    const { provider, requests } = capture(() => textStream("ok"));
    await drain(
      provider.stream({
        messages: [{ content: "Build it", role: "user" }],
        model: "claude-sonnet-4-6",
      }),
    );
    expect(requests[0]?.body.context_management).toBeUndefined();
    expect(requests[0]?.headers.get("anthropic-beta")).toBeNull();
  });

  test("crosses the provider proxy, as deferred tools do", () => {
    const params: AIProviderStreamParams = {
      messages: [{ content: "Build it", role: "user" }],
      model: "claude-sonnet-4-6",
      toolResultClearing: { triggerInputTokens: 100_000 },
      tools: [
        {
          deferLoading: true,
          description: "Set up a database",
          input_schema: schema,
          name: "prepare_database",
        },
      ],
    };
    expect(
      parseProviderProxyParams(JSON.parse(JSON.stringify(params))),
    ).toEqual(params);
  });
});
