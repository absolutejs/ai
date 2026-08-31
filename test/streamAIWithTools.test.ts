import { describe, expect, test } from "bun:test";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import type {
  StreamAIWithToolsEvent,
  StreamAIWithToolsSummary,
} from "../src/ai/streamAIWithTools";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderMessage,
  AIProviderStreamParams,
} from "../types/ai";

// A provider whose stream() replays one scripted chunk array per call, in
// order, and records the messages each call received.
const scriptedProvider = (script: AIChunk[][]) => {
  const calls: AIProviderMessage[][] = [];
  const toolChoices: AIProviderStreamParams["toolChoice"][] = [];
  let index = 0;

  const provider: AIProviderConfig = {
    stream(params: AIProviderStreamParams) {
      calls.push(params.messages);
      toolChoices.push(params.toolChoice);
      const chunks = script[Math.min(index, script.length - 1)];
      index += 1;

      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };

  return { calls, provider, toolChoices };
};

const collect = async (
  iter: AsyncGenerator<StreamAIWithToolsEvent, StreamAIWithToolsSummary>,
) => {
  const events: StreamAIWithToolsEvent[] = [];
  let result = await iter.next();
  while (!result.done) {
    events.push(result.value);
    result = await iter.next();
  }

  return { events, summary: result.value };
};

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
});

describe("streamAIWithTools", () => {
  test("streams a plain answer with no tool round-trip", async () => {
    const { calls, provider, toolChoices } = scriptedProvider([
      [
        { content: "Hello ", type: "text" },
        { content: "world", type: "text" },
        { type: "done", usage: usage(10, 5) },
      ],
    ]);

    const { events, summary } = await collect(
      streamAIWithTools({
        messages: [{ content: "hi", role: "user" }],
        model: "test-model",
        provider,
        tools: {
          echo: {
            description: "echo",
            handler: () => "echoed",
            input: { type: "object" },
          },
        },
      }),
    );

    expect(summary.text).toBe("Hello world");
    expect(summary.turns).toBe(1);
    expect(summary.toolCalls).toHaveLength(0);
    expect(summary.usage).toEqual(usage(10, 5));
    expect(calls).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "text",
      "text",
      "turn",
      "done",
    ]);
  });

  test("executes tools mid-stream and feeds results back", async () => {
    const { calls, provider } = scriptedProvider([
      [
        { content: "Let me look. ", type: "text" },
        { id: "t1", input: { q: "acme" }, name: "lookup", type: "tool_use" },
        { type: "done", usage: usage(10, 5) },
      ],
      [
        { content: "Acme is great.", type: "text" },
        { type: "done", usage: usage(20, 7) },
      ],
    ]);

    const seen: unknown[] = [];
    const { events, summary } = await collect(
      streamAIWithTools({
        messages: [{ content: "tell me about acme", role: "user" }],
        model: "test-model",
        provider,
        tools: {
          lookup: {
            description: "look a thing up",
            handler: (input) => {
              seen.push(input);

              return "acme: 42 employees";
            },
            input: { type: "object" },
          },
        },
      }),
    );

    expect(summary.text).toBe("Let me look. Acme is great.");
    expect(summary.turns).toBe(2);
    expect(summary.toolCalls).toEqual([
      { id: "t1", input: { q: "acme" }, name: "lookup" },
    ]);
    // Usage summed across both turns.
    expect(summary.usage).toEqual(usage(30, 12));
    expect(seen).toEqual([{ q: "acme" }]);

    expect(events.map((event) => event.type)).toEqual([
      "text",
      "turn",
      "tool_start",
      "tool_result",
      "text",
      "turn",
      "done",
    ]);
    const toolResult = events.find((event) => event.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("missing result");
    expect(toolResult.ok).toBe(true);
    expect(toolResult.result).toBe("acme: 42 employees");

    // Second provider call got the assistant tool_use + user tool_result turns.
    expect(calls[1]).toHaveLength(3);
    const [, assistant, toolTurn] = calls[1] ?? [];
    expect(assistant?.role).toBe("assistant");
    expect(toolTurn?.role).toBe("user");
    if (!Array.isArray(toolTurn?.content)) throw new Error("expected blocks");
    expect(toolTurn.content[0]).toEqual({
      content: "acme: 42 employees",
      tool_use_id: "t1",
      type: "tool_result",
    });
  });

  test("a throwing or unknown tool surfaces as an error result, not a crash", async () => {
    const { provider } = scriptedProvider([
      [
        { id: "t1", input: {}, name: "boom", type: "tool_use" },
        { id: "t2", input: {}, name: "missing", type: "tool_use" },
        { type: "done", usage: usage(1, 1) },
      ],
      [
        { content: "recovered", type: "text" },
        { type: "done", usage: usage(1, 1) },
      ],
    ]);

    const { events, summary } = await collect(
      streamAIWithTools({
        messages: [{ content: "go", role: "user" }],
        model: "test-model",
        provider,
        tools: {
          boom: {
            description: "always throws",
            handler: () => {
              throw new Error("kaput");
            },
            input: { type: "object" },
          },
        },
      }),
    );

    expect(summary.text).toBe("recovered");
    const results = events.filter((event) => event.type === "tool_result");
    expect(results).toHaveLength(2);
    if (results[0]?.type !== "tool_result") throw new Error("missing");
    expect(results[0].ok).toBe(false);
    expect(results[0].result).toContain("kaput");
    if (results[1]?.type !== "tool_result") throw new Error("missing");
    expect(results[1].ok).toBe(false);
    expect(results[1].result).toContain('unknown tool "missing"');
  });

  test("breaks the loop when the model repeats an identical call", async () => {
    const repeatTurn: AIChunk[] = [
      { id: "t1", input: { q: "same" }, name: "lookup", type: "tool_use" },
      { type: "done", usage: usage(1, 1) },
    ];
    const { calls, provider } = scriptedProvider([repeatTurn, repeatTurn]);

    let handlerRuns = 0;
    const { summary } = await collect(
      streamAIWithTools({
        messages: [{ content: "go", role: "user" }],
        model: "test-model",
        provider,
        tools: {
          lookup: {
            description: "look up",
            handler: () => {
              handlerRuns += 1;

              return "result";
            },
            input: { type: "object" },
          },
        },
      }),
    );

    // Executed once; the identical repeat broke the loop instead of re-running.
    expect(handlerRuns).toBe(1);
    expect(calls).toHaveLength(2);
    expect(summary.turns).toBe(2);
  });

  test("executes final-turn calls and forces a no-tools synthesis", async () => {
    const alwaysTool = (id: string): AIChunk[] => [
      { id, input: { n: id }, name: "step", type: "tool_use" },
      { type: "done", usage: usage(1, 1) },
    ];
    const { calls, provider, toolChoices } = scriptedProvider([
      alwaysTool("a"),
      alwaysTool("b"),
      [
        { content: "final answer", type: "text" },
        { type: "done", usage: usage(1, 1) },
      ],
    ]);

    let handlerRuns = 0;
    const { summary } = await collect(
      streamAIWithTools({
        maxTurns: 2,
        messages: [{ content: "go", role: "user" }],
        model: "test-model",
        provider,
        tools: {
          step: {
            description: "one step",
            handler: () => {
              handlerRuns += 1;

              return `ran`;
            },
            input: { type: "object" },
          },
        },
      }),
    );

    expect(calls).toHaveLength(3);
    expect(toolChoices[2]).toBe("none");
    expect(handlerRuns).toBe(2);
    expect(summary.turns).toBe(3);
    expect(summary.toolCalls).toHaveLength(2);
    expect(summary.text).toBe("final answer");
  });

  test("preserves thinking blocks (with signature) in the fed-back thread", async () => {
    const { calls, provider } = scriptedProvider([
      [
        { content: "pondering", signature: "sig1", type: "thinking" },
        { id: "t1", input: {}, name: "lookup", type: "tool_use" },
        { type: "done", usage: usage(1, 1) },
      ],
      [
        { content: "answer", type: "text" },
        { type: "done", usage: usage(1, 1) },
      ],
    ]);

    await collect(
      streamAIWithTools({
        messages: [{ content: "go", role: "user" }],
        model: "test-model",
        provider,
        tools: {
          lookup: {
            description: "look up",
            handler: () => "found",
            input: { type: "object" },
          },
        },
      }),
    );

    const assistant = calls[1]?.[1];
    if (!Array.isArray(assistant?.content)) throw new Error("expected blocks");
    expect(assistant.content[0]).toEqual({
      signature: "sig1",
      thinking: "pondering",
      type: "thinking",
    });
    expect(assistant.content[1]).toMatchObject({ id: "t1", type: "tool_use" });
  });
});
