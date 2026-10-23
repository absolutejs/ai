import { testInputCapacity } from "./contextFixture";
import { describe, expect, test } from "bun:test";
import { generateAIWithTools } from "../src/ai/generateAI";
import { resolveRenderers } from "../src/ai/htmxRenderers";
import { anthropic } from "../src/ai/providers/anthropic";
import { gemini } from "../src/ai/providers/gemini";
import { openai } from "../src/ai/providers/openai";
import { openaiResponses } from "../src/ai/providers/openaiResponses";
import { createAIStoredToolResultRecovery } from "../src/ai/storedToolResultRecovery";
import { streamAIToSSE } from "../src/ai/streamAIToSSE";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import { hardenUntrustedTool } from "../src/ai/tools/untrusted";
import type {
  AIChunk,
  AIImageSource,
  AIProviderConfig,
  AIProviderMessage,
  AIProviderStreamParams,
  AIToolMap,
} from "../types/ai";

const SHOT: AIImageSource = {
  data: "c2NyZWVu",
  media_type: "image/jpeg",
  type: "base64",
};

const tools: AIToolMap = {
  screenshot: {
    description: "Look at the page",
    handler: () => ({ images: [SHOT], text: "The page at 1280px." }),
    input: { type: "object" },
  },
};

/* Calls the tool once, then answers; keeps every request it was sent. */
const recordingProvider = () => {
  const requests: AIProviderMessage[][] = [];
  let call = 0;
  const provider: AIProviderConfig = {
    inputCapacity: testInputCapacity,
    stream: (params: AIProviderStreamParams) => {
      requests.push(structuredClone(params.messages));
      const turn = call++;

      return (async function* () {
        if (turn === 0)
          yield {
            id: "toolu_1",
            input: {},
            name: "screenshot",
            type: "tool_use",
          } as AIChunk;
        else yield { content: "Looks right.", type: "text" } as AIChunk;
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as AIChunk;
      })();
    },
  };

  return { provider, requests };
};

const sentToolResult = (requests: AIProviderMessage[][]) =>
  requests[1]
    ?.flatMap((message) =>
      typeof message.content === "string" ? [] : message.content,
    )
    .find((block) => block.type === "tool_result");

const toolTurn: AIProviderMessage[] = [
  { content: "Check the copy", role: "user" },
  {
    content: [
      { id: "call_1", input: {}, name: "screenshot", type: "tool_use" },
    ],
    role: "assistant",
  },
  {
    content: [
      {
        content: "The page at 1280px.",
        images: [SHOT],
        tool_use_id: "call_1",
        type: "tool_result",
      },
    ],
    role: "user",
  },
];

const capture = async (
  stream: (params: AIProviderStreamParams) => AsyncIterable<AIChunk>,
) => {
  try {
    for await (const _chunk of stream({
      messages: toolTurn,
      model: "test-model",
    }));
  } catch {
    // Only the request matters; the canned response may not parse.
  }
};

describe("images returned by tools", () => {
  test("streamAIToSSE sends them to the model and shows the UI the text", async () => {
    const { provider, requests } = recordingProvider();
    const seen: string[] = [];
    const events: string[] = [];
    for await (const event of streamAIToSSE(
      "c",
      "m",
      {
        messages: [{ content: "Check the copy", role: "user" }],
        model: "claude-sonnet-4-6",
        onToolUse: (_name, _input, result) => seen.push(result),
        provider,
        structuredEvents: true,
        tools,
      },
      resolveRenderers(),
    ))
      if (event.event === "tools") events.push(String(event.data));

    expect(sentToolResult(requests)).toEqual({
      content: "The page at 1280px.",
      images: [SHOT],
      tool_use_id: "toolu_1",
      type: "tool_result",
    });
    expect(seen).toEqual(["The page at 1280px."]);
    expect(events.at(-1)).toContain('"result":"The page at 1280px."');
  });

  test("streamAIWithTools and generateAIWithTools send them too", async () => {
    const streamed = recordingProvider();
    for await (const _event of streamAIWithTools({
      messages: [{ content: "Check the copy", role: "user" }],
      model: "claude-sonnet-4-6",
      provider: streamed.provider,
      tools,
    }));
    expect(sentToolResult(streamed.requests)?.images).toEqual([SHOT]);

    const generated = recordingProvider();
    await generateAIWithTools({
      messages: [{ content: "Check the copy", role: "user" }],
      model: "claude-sonnet-4-6",
      provider: generated.provider,
      tools,
    });
    expect(sentToolResult(generated.requests)?.images).toEqual([SHOT]);
  });

  test("a hardened untrusted tool frames the text and keeps the images", async () => {
    const hardened = hardenUntrustedTool(tools.screenshot!, {
      source: "mcp",
    });
    const output = await hardened.handler({});
    expect(typeof output === "object" && output.images).toEqual([SHOT]);
    expect(typeof output === "object" && output.text).toContain(
      "The page at 1280px.",
    );
  });

  test("an earlier result swapped for a marker drops its images", async () => {
    const later: AIProviderMessage[] = [
      ...toolTurn,
      {
        content: [
          { id: "call_2", input: {}, name: "screenshot", type: "tool_use" },
        ],
        role: "assistant",
      },
      {
        content: [
          { content: "again", tool_use_id: "call_2", type: "tool_result" },
        ],
        role: "user",
      },
    ];
    const recovered = await createAIStoredToolResultRecovery(["screenshot"])({
      capacity: {} as never,
      params: { messages: later, model: "m" },
      reason: "preflight" as never,
    });
    const first = recovered[2]?.content;
    expect(
      Array.isArray(first) && first[0]?.type === "tool_result" && first[0],
    ).not.toHaveProperty("images");
  });
});

describe("each provider's wire format", () => {
  test("Anthropic puts the images inside the tool_result", async () => {
    let body: { messages?: { content?: unknown[] }[] } = {};
    await capture(
      anthropic({
        apiKey: "test",
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          body = JSON.parse(String(init?.body));

          return new Response("");
        }) as typeof fetch,
      }).stream,
    );
    expect(body.messages?.[2]?.content?.[0]).toMatchObject({
      content: [
        { text: "The page at 1280px.", type: "text" },
        { source: SHOT, type: "image" },
      ],
      tool_use_id: "call_1",
      type: "tool_result",
    });
  });

  test("OpenAI Responses puts them in the function_call_output", async () => {
    let body: { input?: Record<string, unknown>[] } = {};
    await capture(
      openaiResponses({
        apiKey: "test",
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));

          return new Response("");
        },
      }).stream,
    );
    expect(
      body.input?.find((item) => item.type === "function_call_output"),
    ).toEqual({
      call_id: "call_1",
      output: [
        { text: "The page at 1280px.", type: "input_text" },
        {
          detail: "auto",
          image_url: "data:image/jpeg;base64,c2NyZWVu",
          type: "input_image",
        },
      ],
      type: "function_call_output",
    });
  });

  test("OpenAI Chat Completions follows the tool messages with one user message", async () => {
    let body: { messages?: Record<string, unknown>[] } = {};
    await capture(
      openai({
        apiKey: "test",
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          body = JSON.parse(String(init?.body));

          return new Response("");
        }) as typeof fetch,
      }).stream,
    );
    const roles = body.messages?.map((message) => message.role);
    expect(roles?.slice(-3)).toEqual(["assistant", "tool", "user"]);
    expect(body.messages?.at(-2)?.content).toBe("The page at 1280px.");
    expect(body.messages?.at(-1)?.content).toEqual([
      { text: "Images returned by the tool calls above:", type: "text" },
      {
        image_url: { url: "data:image/jpeg;base64,c2NyZWVu" },
        type: "image_url",
      },
    ]);
  });

  test("Gemini sends them beside the function response", async () => {
    let body: { contents?: { parts?: unknown[] }[] } = {};
    await capture(
      gemini({
        apiKey: "test",
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          body = JSON.parse(String(init?.body));

          return new Response("");
        }) as typeof fetch,
      }).stream,
    );
    expect(body.contents?.at(-1)?.parts).toEqual([
      {
        functionResponse: {
          name: "call_1",
          response: { result: "The page at 1280px." },
        },
      },
      { inlineData: { data: "c2NyZWVu", mimeType: "image/jpeg" } },
    ]);
  });
});

describe("compact model projections", () => {
  const full = "Full UI evidence ".repeat(5000);
  const modelText =
    "Saved source ref-1; read_source returns exact evidence. Outcome: blocked.";
  const projected: AIToolMap = {
    screenshot: {
      ...tools.screenshot!,
      handler: () => ({ text: full, modelText, images: [SHOT] }),
    },
  };
  test("all agent loops send compact text while observers retain the original and images", async () => {
    const generated = recordingProvider();
    const seen: string[] = [];
    await generateAIWithTools({
      messages: [],
      model: "test",
      provider: generated.provider,
      tools: projected,
      onToolUse: (_n, _i, r) => {
        seen.push(r);
      },
    });
    expect(sentToolResult(generated.requests)?.content).toBe(modelText);
    expect(sentToolResult(generated.requests)?.images).toEqual([SHOT]);
    expect(seen).toEqual([full]);
    const streamed = recordingProvider();
    for await (const event of streamAIWithTools({
      messages: [],
      model: "test",
      provider: streamed.provider,
      tools: projected,
    }))
      if (event.type === "tool_result") expect(event.result).toBe(full);
    expect(sentToolResult(streamed.requests)?.content).toBe(modelText);
    const sse = recordingProvider();
    for await (const _event of streamAIToSSE(
      "c",
      "m",
      { messages: [], model: "test", provider: sse.provider, tools: projected },
      resolveRenderers(),
    ));
    expect(sentToolResult(sse.requests)?.content).toBe(modelText);
  });
  test("untrusted projections cannot bypass framing or size limits", async () => {
    const output = await hardenUntrustedTool(projected.screenshot!, {
      maxOutputChars: 30,
    }).handler({});
    expect(typeof output).toBe("object");
    if (typeof output !== "object") throw Error("Expected rich result");
    expect(output.modelText).toContain("<untrusted_tool_output>");
    expect(output.modelText).toContain("[truncated]");
    expect(output.images).toEqual([SHOT]);
  });
});
