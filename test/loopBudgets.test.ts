import { afterEach, describe, expect, test } from "bun:test";
import { anthropic } from "../src/ai/providers/anthropic";
import { resolveRenderers } from "../src/ai/htmxRenderers";
import { streamAIToSSE } from "../src/ai/streamAIToSSE";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderMessage,
  AIProviderStreamParams,
  AIUsage,
} from "../types/ai";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sseBody = (events: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      controller.close();
    },
  });

// Minimal valid stream the parser accepts and closes cleanly.
const DONE_SSE = [
  `event: message_start\ndata: ${JSON.stringify({
    message: { usage: { input_tokens: 1, output_tokens: 0 } },
    type: "message_start",
  })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    delta: { stop_reason: "end_turn" },
    type: "message_delta",
    usage: { output_tokens: 1 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const drain = async (iter: AsyncIterable<AIChunk>) => {
  for await (const _chunk of iter) void _chunk;
};

// Capture the request body the provider sends, returning a clean done stream.
const captureBody = () => {
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    captured.body = JSON.parse(init.body);

    return { body: sseBody(DONE_SSE), ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  return captured;
};

const cacheParams = {
  messages: [
    { content: "first", role: "user" },
    { content: "reply", role: "assistant" },
    { content: "second", role: "user" },
  ],
  model: "claude-sonnet-4-6",
  systemPrompt: "You are a helpful assistant.",
  tools: [
    { description: "tool a", input_schema: { type: "object" }, name: "a" },
    { description: "tool b", input_schema: { type: "object" }, name: "b" },
  ],
} as AIProviderStreamParams;

describe("Fix 1: prompt caching breakpoints", () => {
  test("default-on caches tools, system, and the rolling message prefix", async () => {
    const captured = captureBody();
    await drain(
      anthropic({ apiKey: "test", baseUrl: "http://localhost" }).stream(
        cacheParams,
      ),
    );

    const body = captured.body!;
    const tools = body.tools as Array<Record<string, unknown>>;
    const system = body.system as Array<Record<string, unknown>>;
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>> | string;
    }>;

    // Tools: only the LAST tool carries the breakpoint.
    expect(tools[tools.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(tools[0]!.cache_control).toBeUndefined();

    // System: block-array form with a breakpoint.
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });

    // Rolling prefix: last message's final content block is tagged (string
    // content collapses to a single cached text block).
    const last = messages[messages.length - 1]!;
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
    });

    // Breakpoint budget stays within Anthropic's max of 4.
    const breakpoints =
      JSON.stringify(body).split('"cache_control"').length - 1;
    expect(breakpoints).toBeLessThanOrEqual(4);
    expect(breakpoints).toBe(3);
  });

  test("promptCaching: false emits no breakpoints", async () => {
    const captured = captureBody();
    await drain(
      anthropic({
        apiKey: "test",
        baseUrl: "http://localhost",
        promptCaching: false,
      }).stream(cacheParams),
    );

    const body = captured.body!;
    expect(typeof body.system).toBe("string");
    expect(JSON.stringify(body).includes("cache_control")).toBe(false);
  });

  test("single-message turn gets no rolling breakpoint", async () => {
    const captured = captureBody();
    await drain(
      anthropic({ apiKey: "test", baseUrl: "http://localhost" }).stream({
        messages: [{ content: "only", role: "user" }],
        model: "claude-sonnet-4-6",
      } as AIProviderStreamParams),
    );

    const messages = captured.body!.messages as Array<{ content: unknown }>;
    // No tools/system here, and the lone message stays an untagged string.
    expect(messages[0]!.content).toBe("only");
  });
});

// --- Chunk-level fake providers for the streamTurns fixes ---

const doneProvider = (usage: AIUsage, text = "ok"): AIProviderConfig => ({
  stream: () =>
    (async function* () {
      yield { content: text, type: "text" } as AIChunk;
      yield { type: "done", usage } as AIChunk;
    })(),
});

describe("Fix 2: onTurn observability", () => {
  test("fires once per turn with that turn's usage", async () => {
    const calls: Array<{ turn: number; usage?: AIUsage }> = [];
    const renderers = resolveRenderers();
    for await (const _evt of streamAIToSSE(
      "c",
      "m",
      {
        model: "claude-sonnet-4-6",
        onTurn: (turn, usage) => calls.push({ turn, usage }),
        provider: doneProvider({ inputTokens: 5, outputTokens: 7 }),
      },
      renderers,
    )) {
      void _evt;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.turn).toBe(0);
    expect(calls[0]!.usage?.outputTokens).toBe(7);
  });
});

const collect = async (provider: AIProviderConfig, extra = {}) => {
  const renderers = resolveRenderers();
  const events: Array<{ data: string; event: string }> = [];
  for await (const evt of streamAIToSSE(
    "c",
    "m",
    { model: "claude-sonnet-4-6", provider, ...extra },
    renderers,
  )) {
    events.push(evt);
  }

  return events;
};

describe("Fix 3: spend & wall-clock ceilings", () => {
  test("maxTotalTokens aborts with a status event", async () => {
    const events = await collect(
      doneProvider({ inputTokens: 600, outputTokens: 600 }),
      { maxTotalTokens: 1000 },
    );

    const status = events.filter((e) => e.event === "status");
    expect(status).toHaveLength(1);
    expect(status[0]!.data).toContain("token budget reached");
    expect(status[0]!.data).toContain("1200/1000");
  });

  test("maxDurationMs aborts with a status event", async () => {
    const slowProvider: AIProviderConfig = {
      stream: () =>
        (async function* () {
          await new Promise((r) => setTimeout(r, 5));
          yield { content: "ok", type: "text" } as AIChunk;
          yield {
            type: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          } as AIChunk;
        })(),
    };

    const events = await collect(slowProvider, { maxDurationMs: 1 });
    const status = events.filter((e) => e.event === "status");
    expect(status).toHaveLength(1);
    expect(status[0]!.data).toContain("time budget reached");
  });

  test("both unset preserves normal completion", async () => {
    const events = await collect(
      doneProvider({ inputTokens: 5, outputTokens: 5 }),
    );
    expect(
      events.some(
        (e) =>
          e.data.includes("token budget reached") ||
          e.data.includes("time budget reached"),
      ),
    ).toBe(false);
  });
});

describe("Fix 4: tool-result size guard", () => {
  const bigBlob = "X".repeat(5000);

  // Two-turn provider that snapshots the messages it receives each turn.
  const recordingProvider = (snapshots: AIProviderMessage[][]) => {
    let call = 0;

    return {
      stream: (params: AIProviderStreamParams) => {
        snapshots.push(JSON.parse(JSON.stringify(params.messages)));
        const turn = call++;

        return (async function* () {
          if (turn === 0) {
            yield {
              id: "toolu_1",
              input: {},
              name: "big",
              type: "tool_use",
            } as AIChunk;
            yield {
              type: "done",
              usage: { inputTokens: 5, outputTokens: 5 },
            } as AIChunk;

            return;
          }

          yield { content: "finished", type: "text" } as AIChunk;
          yield {
            type: "done",
            usage: { inputTokens: 5, outputTokens: 5 },
          } as AIChunk;
        })();
      },
    } as AIProviderConfig;
  };

  const findToolResult = (messages: AIProviderMessage[]) => {
    for (const msg of messages) {
      if (typeof msg.content === "string") continue;
      for (const block of msg.content) {
        if ((block as { type?: string }).type === "tool_result") {
          return (block as { content: string }).content;
        }
      }
    }

    return undefined;
  };

  const tools = {
    big: {
      description: "returns a big blob",
      handler: () => bigBlob,
      input: { type: "object" },
    },
  };

  test("clips the result fed back into the message array", async () => {
    const snapshots: AIProviderMessage[][] = [];
    for await (const _e of streamAIToSSE(
      "c",
      "m",
      {
        maxToolResultChars: 100,
        model: "claude-sonnet-4-6",
        provider: recordingProvider(snapshots),
        tools,
      },
      resolveRenderers(),
    )) {
      void _e;
    }

    // Turn 2's messages carry the truncated tool_result.
    const clipped = findToolResult(snapshots[1]!);
    expect(clipped).toBeDefined();
    expect(clipped!).toContain("<result truncated to 100 chars;");
    expect(clipped!).toContain("4900 omitted");
    expect(clipped!.length).toBeLessThan(bigBlob.length);
  });

  test("unset = no truncation", async () => {
    const snapshots: AIProviderMessage[][] = [];
    for await (const _e of streamAIToSSE(
      "c",
      "m",
      {
        model: "claude-sonnet-4-6",
        provider: recordingProvider(snapshots),
        tools,
      },
      resolveRenderers(),
    )) {
      void _e;
    }

    expect(findToolResult(snapshots[1]!)).toBe(bigBlob);
  });
});
