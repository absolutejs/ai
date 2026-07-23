import { describe, expect, test } from "bun:test";
import { resolveRenderers } from "../src/ai/htmxRenderers";
import { streamAIToSSE } from "../src/ai/streamAIToSSE";
import type { AIChunk, AIProviderConfig, AIUsage } from "../types/ai";

type SSEEvent = { data: string; event: string };

const MODEL = "claude-sonnet-4-6";

// Drive streamAIToSSE to completion and collect every emitted SSE frame.
const collect = async (
  provider: AIProviderConfig,
  extra: Record<string, unknown> = {},
) => {
  const events: SSEEvent[] = [];
  for await (const evt of streamAIToSSE(
    "c",
    "m",
    { model: MODEL, provider, structuredEvents: true, ...extra },
    resolveRenderers(),
  )) {
    events.push(evt);
  }

  return events;
};

const doneProvider = (usage: AIUsage, text = "ok"): AIProviderConfig => ({
  stream: () =>
    (async function* () {
      yield { content: text, type: "text" } as AIChunk;
      yield { type: "done", usage } as AIChunk;
    })(),
});

describe("structuredEvents: terminal events are distinct + JSON", () => {
  test("normal completion → event:'complete' with {usage,durationMs,model}", async () => {
    const events = await collect(
      doneProvider({ inputTokens: 5, outputTokens: 7 }),
    );

    // No terminal should be emitted under the legacy `status` name.
    expect(events.some((e) => e.event === "status")).toBe(false);

    const complete = events.find((e) => e.event === "complete");
    expect(complete).toBeDefined();
    const payload = JSON.parse(complete!.data);
    expect(payload.model).toBe(MODEL);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(payload.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  test("token ceiling → event:'stopped' reason 'max_total_tokens'", async () => {
    const events = await collect(
      doneProvider({ inputTokens: 600, outputTokens: 600 }),
      { maxTotalTokens: 1000 },
    );

    const stopped = events.find((e) => e.event === "stopped");
    expect(stopped).toBeDefined();
    const payload = JSON.parse(stopped!.data);
    expect(payload.reason).toBe("max_total_tokens");
    expect(payload.detail).toContain("1200/1000");
    // Not misreported as a completion or an error.
    expect(events.some((e) => e.event === "complete")).toBe(false);
    expect(events.some((e) => e.event === "error")).toBe(false);
  });

  test("time ceiling → event:'stopped' reason 'max_duration_ms'", async () => {
    const slow: AIProviderConfig = {
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

    const events = await collect(slow, { maxDurationMs: 1 });
    const stopped = events.find((e) => e.event === "stopped");
    expect(stopped).toBeDefined();
    expect(JSON.parse(stopped!.data).reason).toBe("max_duration_ms");
  });

  test("max_tokens truncation → event:'stopped' reason 'max_tokens'", async () => {
    const truncated: AIProviderConfig = {
      stream: () =>
        (async function* () {
          yield { content: "Planning...", type: "text" } as AIChunk;
          yield {
            stopReason: "max_tokens",
            type: "done",
            usage: { inputTokens: 5, outputTokens: 200 },
          } as AIChunk;
        })(),
    };

    const events = await collect(truncated);
    const stopped = events.find((e) => e.event === "stopped");
    expect(stopped).toBeDefined();
    const payload = JSON.parse(stopped!.data);
    expect(payload.reason).toBe("max_tokens");
    expect(payload.detail).toContain("output=200");
  });

  test("maxTurns exhaustion → event:'stopped' reason 'max_turns'", async () => {
    // A provider that returns a *unique* tool call every turn never repeats and
    // never yields a final answer, so the loop runs until maxTurns is spent.
    let n = 0;
    const looping: AIProviderConfig = {
      stream: () => {
        const i = n++;

        return (async function* () {
          yield {
            id: `t${i}`,
            input: { i },
            name: "probe",
            type: "tool_use",
          } as AIChunk;
          yield {
            type: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          } as AIChunk;
        })();
      },
    };

    const events = await collect(looping, {
      maxTurns: 2,
      tools: {
        probe: {
          description: "probe",
          handler: () => "ok",
          input: { type: "object" },
        },
      },
    });

    const stopped = events.find((e) => e.event === "stopped");
    expect(stopped).toBeDefined();
    expect(JSON.parse(stopped!.data).reason).toBe("max_turns");
  });

  test("thrown error → event:'error' with {message}", async () => {
    const throwing: AIProviderConfig = {
      stream: () =>
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error("boom");
        })(),
    };

    const events = await collect(throwing);
    const err = events.find((e) => e.event === "error");
    expect(err).toBeDefined();
    expect(JSON.parse(err!.data).message).toBe("boom");
    expect(events.some((e) => e.event === "complete")).toBe(false);
  });
});

describe("structuredEvents: delta events carry JSON payloads", () => {
  test("content delta → {delta, full}", async () => {
    const events = await collect(
      doneProvider({ inputTokens: 1, outputTokens: 1 }, "hello"),
    );
    const content = events.find((e) => e.event === "content");
    expect(content).toBeDefined();
    expect(JSON.parse(content!.data)).toEqual({
      delta: "hello",
      full: "hello",
    });
  });

  test("thinking delta → {text} (accumulated)", async () => {
    const thinker: AIProviderConfig = {
      stream: () =>
        (async function* () {
          yield { content: "rea", signature: "", type: "thinking" } as AIChunk;
          yield { content: "son", signature: "", type: "thinking" } as AIChunk;
          yield { content: "done", type: "text" } as AIChunk;
          yield {
            type: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          } as AIChunk;
        })(),
    };

    const events = await collect(thinker);
    const thinking = events.filter((e) => e.event === "thinking");
    expect(JSON.parse(thinking.at(-1)!.data)).toEqual({ text: "reason" });
  });

  test("tool transitions → granular {name,status,input,result}", async () => {
    let call = 0;
    const provider: AIProviderConfig = {
      stream: () => {
        const turn = call++;

        return (async function* () {
          if (turn === 0) {
            yield {
              id: "toolu_1",
              input: { q: 1 },
              name: "probe",
              type: "tool_use",
            } as AIChunk;
            yield {
              type: "done",
              usage: { inputTokens: 1, outputTokens: 1 },
            } as AIChunk;

            return;
          }
          yield { content: "final", type: "text" } as AIChunk;
          yield {
            type: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          } as AIChunk;
        })();
      },
    };

    const events = await collect(provider, {
      tools: {
        probe: {
          description: "probe",
          handler: () => "probed-result",
          input: { type: "object" },
        },
      },
    });

    const tools = events
      .filter((e) => e.event === "tools")
      .map((e) => JSON.parse(e.data));
    expect(tools).toEqual([
      { input: { q: 1 }, name: "probe", status: "running" },
      {
        input: { q: 1 },
        name: "probe",
        result: "probed-result",
        status: "complete",
      },
    ]);
  });

  test("image → {data, format, revisedPrompt}", async () => {
    const imager: AIProviderConfig = {
      stream: () =>
        (async function* () {
          yield {
            data: "AAAA",
            format: "png",
            isPartial: false,
            revisedPrompt: "a cat",
            type: "image",
          } as AIChunk;
          yield {
            type: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          } as AIChunk;
        })(),
    };

    const events = await collect(imager);
    const image = events.find((e) => e.event === "images");
    expect(image).toBeDefined();
    expect(JSON.parse(image!.data)).toEqual({
      data: "AAAA",
      format: "png",
      revisedPrompt: "a cat",
    });
  });
});

// A provider that streams two text chunks so a caller can abort mid-stream.
const twoChunkProvider: AIProviderConfig = {
  stream: () =>
    (async function* () {
      yield { content: "one", type: "text" } as AIChunk;
      yield { content: "two", type: "text" } as AIChunk;
      yield {
        type: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
      } as AIChunk;
    })(),
};

// Abort right after the first content frame, then drain the rest.
const collectWithAbort = async (structuredEvents: boolean) => {
  const controller = new AbortController();
  const events: SSEEvent[] = [];
  for await (const evt of streamAIToSSE(
    "c",
    "m",
    {
      model: MODEL,
      provider: twoChunkProvider,
      signal: controller.signal,
      structuredEvents,
    },
    resolveRenderers(),
  )) {
    events.push(evt);
    if (evt.event === "content") controller.abort();
  }

  return events;
};

describe("AbortSignal → one clean terminal, not a fake completion", () => {
  test("structured: terminal is stopped/aborted", async () => {
    const events = await collectWithAbort(true);
    const stopped = events.filter((e) => e.event === "stopped");
    expect(stopped).toHaveLength(1);
    expect(JSON.parse(stopped[0]!.data).reason).toBe("aborted");
    // Never reported as a completion.
    expect(events.some((e) => e.event === "complete")).toBe(false);
  });

  test("legacy: terminal is a canceled chip, not ai-usage", async () => {
    const events = await collectWithAbort(false);
    const terminal = events.filter((e) => e.event === "status");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.data).toContain("ai-canceled");
    expect(terminal[0]!.data).not.toContain("ai-usage");
  });
});
