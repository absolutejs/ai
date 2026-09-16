import { expect, test } from "bun:test";
import {
  inspectAIContext,
  streamWithAIContext,
  isAIContextRejection,
  type AIContextPolicy,
} from "../src/ai/contextPolicy";
import { ProviderError } from "../src/ai/errors/providerError";
import {
  generateAI,
  generateAIWithTools,
  generateObjectAI,
} from "../src/ai/generateAI";
import { streamAIWithTools } from "../src/ai/streamAIWithTools";
import { streamAIToSSE } from "../src/ai/streamAIToSSE";
import { streamAI } from "../src/ai/streamAI";
import { resolveRenderers } from "../src/ai/htmxRenderers";
import type {
  AIProviderConfig,
  AIProviderStreamParams,
  AIProviderMessage,
  AIChunk,
} from "../types/ai";

const collect = async <T>(stream: AsyncIterable<T>) => {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};
const fixture = (limit = 1000) => {
  const requests: AIProviderStreamParams[] = [];
  const counted: AIProviderStreamParams[] = [];
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async (params) => ({
        maxInputTokens: params.model === "small" ? 100 : limit,
        maxOutputTokens: 100,
        contextWindowTokens: params.model === "small" ? 100 : limit,
      }),
      countTokens: async (params) => {
        counted.push(structuredClone({ ...params, signal: undefined }));
        return JSON.stringify({
          messages: params.messages,
          systemPrompt: params.systemPrompt,
          tools: params.tools,
          responseFormat: params.responseFormat,
          reasoning: params.reasoning,
        }).length;
      },
    },
    stream: async function* (params) {
      requests.push(structuredClone({ ...params, signal: undefined }));
      yield { type: "text", content: "answer" };
      yield { type: "done" };
    },
  };
  return { provider, requests, counted };
};
const request: AIProviderStreamParams = {
  model: "model",
  maxTokens: 100,
  messages: [{ role: "user", content: "short" }],
};
const noReserve = { countingMarginTokens: 0, toolResultReserveTokens: 0 };
const capacityError = () =>
  ProviderError.fromResponse(
    "openai",
    400,
    JSON.stringify({
      error: { code: "context_length_exceeded", message: "Too many tokens" },
    }),
  );

test("working capacity counts the final request and separates output, margin and tool headroom", async () => {
  const { provider, counted } = fixture();
  const params = {
    ...request,
    systemPrompt: "Instructions",
    tools: [
      { name: "read", description: "read", input_schema: { type: "object" } },
    ],
    responseFormat: { type: "json_object" as const },
    reasoning: { effort: "low" as const },
  };
  const result = await inspectAIContext(provider, params);
  expect(counted[0]).toEqual(params);
  expect(result.availableInputTokens).toBe(900);
  expect(result.countingMarginTokens).toBe(9);
  expect(result.toolResultReserveTokens).toBe(90);
  expect(result.workingInputTokens).toBe(801);
  expect(
    (await inspectAIContext(provider, params, { workingInputTokens: 100 }))
      .withinWorkingLimit,
  ).toBe(false);
  expect(
    (await inspectAIContext(provider, { ...params, model: "small" })).fits,
  ).toBe(false);
});

test("all high-level entrypoints reject oversized final requests before dispatch", async () => {
  const { provider, requests } = fixture();
  const options = {
    ...request,
    messages: [{ role: "user" as const, content: "x".repeat(2000) }],
    provider,
  };
  for (const run of [
    () => generateAI(options),
    () => generateObjectAI({ ...options, schema: { type: "object" } }),
    () => generateAIWithTools({ ...options, tools: {} }),
    () => collect(streamAIWithTools({ ...options, tools: {} })),
  ])
    await expect(run()).rejects.toMatchObject({ code: "input_too_large" });
  const sse = await collect(
    streamAIToSSE(
      "c",
      "m",
      { ...options, structuredEvents: true },
      resolveRenderers(),
    ),
  );
  expect(sse.some((event) => event.event === "error")).toBe(true);
  const ws: any[] = [];
  await streamAI(
    {
      readyState: 1,
      send: (value) => {
        ws.push(JSON.parse(value));
      },
    },
    "c",
    "m",
    options,
  );
  expect(ws.some((event) => event.type === "error")).toBe(true);
  expect(requests).toHaveLength(0);
});

test("unknown capabilities fail explicitly; raw opt-out remains deliberate", async () => {
  const { provider, requests } = fixture();
  delete provider.inputCapacity;
  await expect(generateAI({ ...request, provider })).rejects.toMatchObject({
    code: "capacity_unavailable",
  });
  expect(requests).toHaveLength(0);
  expect(
    (await generateAI({ ...request, provider, contextPolicy: false })).text,
  ).toBe("answer");
});

test("recovery receives an isolated original and persists its reduced history across tool turns", async () => {
  const { provider, counted } = fixture(1500);
  let turns = 0;
  let effects = 0;
  let recoveries = 0;
  const requests: AIProviderStreamParams[] = [];
  provider.stream = async function* (params) {
    requests.push(structuredClone(params));
    turns++;
    if (turns === 1) {
      yield { type: "thinking", content: "reason", signature: "signed" };
      yield {
        type: "tool_use",
        id: "read1",
        name: "read",
        input: {},
        providerData: { signature: "native" },
      };
    } else if (turns === 2)
      yield {
        type: "tool_use",
        id: "read2",
        name: "read",
        input: { second: true },
      };
    else yield { type: "text", content: "finished" };
    yield { type: "done" };
  };
  const messages: AIProviderMessage[] = [{ role: "user", content: "Question" }];
  const contextPolicy: AIContextPolicy = {
    ...noReserve,
    recover: async ({ params }) => {
      recoveries++;
      return params.messages.map((message) => ({
        ...message,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) =>
                block.type === "tool_result"
                  ? { ...block, content: "Verified original-source notes" }
                  : block,
              ),
      }));
    },
  };
  const result = await generateAIWithTools({
    ...request,
    provider,
    messages,
    contextPolicy,
    tools: {
      read: {
        description: "read",
        input: {},
        handler: () => {
          effects++;
          return effects === 1 ? "x".repeat(2000) : "tiny";
        },
      },
    },
  });
  expect(result.text).toBe("finished");
  expect(effects).toBe(2);
  expect(recoveries).toBe(1);
  expect(JSON.stringify(requests[2]?.messages)).not.toContain("x".repeat(2000));
  expect(JSON.stringify(requests[1]?.messages)).toContain(
    '"signature":"signed"',
  );
  expect(JSON.stringify(requests[1]?.messages)).toContain(
    '"signature":"native"',
  );
  expect(messages).toEqual([{ role: "user", content: "Question" }]);
  expect(counted.length).toBe(4);
});

test("streaming recovery never reexecutes a completed terminal effect", async () => {
  const { provider } = fixture(1200);
  let turns = 0;
  let reads = 0;
  let finishes = 0;
  provider.stream = async function* () {
    turns++;
    yield {
      type: "tool_use",
      id: String(turns),
      name: turns === 1 ? "read" : "finish",
      input: {},
    };
    yield { type: "done" };
  };
  await collect(
    streamAIWithTools({
      ...request,
      provider,
      contextPolicy: {
        recover: async ({ params }) =>
          params.messages.map((message) => ({
            ...message,
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map((block) =>
                    block.type === "tool_result"
                      ? { ...block, content: "Saved original: 17,431.29" }
                      : block,
                  ),
          })),
      },
      stopAfterTools: ["finish"],
      tools: {
        read: {
          description: "read",
          input: {},
          handler: () => {
            reads++;
            return "x".repeat(2000);
          },
        },
        finish: {
          description: "finish",
          input: {},
          handler: () => {
            finishes++;
            return "saved";
          },
        },
      },
    }),
  );
  expect(reads).toBe(1);
  expect(finishes).toBe(1);
  expect(turns).toBe(2);
});

test("genuine provider rejection gets one bounded recovery; arbitrary 400s and partial streams do not", async () => {
  for (const kind of ["capacity", "other", "partial", "repeated"] as const) {
    const { provider } = fixture();
    let calls = 0;
    let recoveries = 0;
    provider.stream = async function* () {
      calls++;
      if (kind === "partial")
        yield { type: "text", content: "already visible" };
      if (calls === 1 || kind === "repeated")
        throw kind === "other"
          ? ProviderError.fromResponse(
              "openai",
              400,
              '{"error":{"code":"invalid_parameter"}}',
            )
          : capacityError();
      yield { type: "done" };
    };
    const run = () =>
      collect(
        streamWithAIContext(
          provider,
          {
            ...request,
            messages: [{ role: "user", content: "A longer original request" }],
          },
          {
            recover: async () => {
              recoveries++;
              return [{ role: "user", content: "Short" }];
            },
          },
        ),
      );
    if (kind === "capacity") await run();
    else await expect(run()).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(kind === "capacity" || kind === "repeated" ? 2 : 1);
    expect(recoveries).toBe(kind === "capacity" || kind === "repeated" ? 1 : 0);
  }
});

test("a generic Anthropic invalid request is not a context rejection", () => {
  const error = (message: string) =>
    ProviderError.fromResponse(
      "anthropic",
      400,
      JSON.stringify({ error: { type: "invalid_request_error", message } }),
    );
  expect(
    isAIContextRejection(
      error("prompt is too long: 211180 tokens > 200000 maximum"),
    ),
  ).toBe(true);
  expect(isAIContextRejection(error("invalid tool schema"))).toBe(false);
  expect(
    isAIContextRejection(
      new Error("prompt is too long: 211180 tokens > 200000 maximum"),
    ),
  ).toBe(false);
});

test("recovery cannot delete tool history, move signed reasoning, alter inputs, or change media", async () => {
  const { provider, requests } = fixture(700);
  const messages: AIProviderMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason", signature: "signature" },
        {
          type: "tool_use",
          id: "call",
          name: "read",
          input: { original: true },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call", content: "x".repeat(1000) },
      ],
    },
  ];
  for (const recover of [
    async () => [{ role: "user" as const, content: "notes" }],
    async ({ params }: any) => {
      params.messages[0].content[0].signature = "forged";
      params.messages[1].content[0].content = "notes";
      return params.messages;
    },
    async ({ params }: any) => {
      params.messages[0].content[1].input = {};
      params.messages[1].content[0].content = "notes";
      return params.messages;
    },
  ])
    await expect(
      collect(
        streamWithAIContext(provider, { ...request, messages }, { recover }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_content" });
  expect(requests).toHaveLength(0);
  expect((messages[0]!.content as any[])[0].signature).toBe("signature");
});

test("non-shrinking and still-oversized recovery stop without repeated work", async () => {
  const { provider, requests } = fixture();
  let attempts = 0;
  await expect(
    collect(
      streamWithAIContext(
        provider,
        { ...request, messages: [{ role: "user", content: "x".repeat(2000) }] },
        {
          recover: async ({ params }) => {
            attempts++;
            return params.messages;
          },
        },
      ),
    ),
  ).rejects.toMatchObject({ code: "input_too_large" });
  expect(attempts).toBe(1);
  expect(requests).toHaveLength(0);
});

test("output overflow cannot be fixed by reducing input; cancellation dispatches nothing", async () => {
  const { provider, requests } = fixture();
  let recoveries = 0;
  await expect(
    collect(
      streamWithAIContext(
        provider,
        { ...request, maxTokens: 101 },
        {
          recover: async () => {
            recoveries++;
            return [];
          },
        },
      ),
    ),
  ).rejects.toMatchObject({ code: "input_too_large" });
  await expect(
    generateAI({ ...request, provider, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(recoveries).toBe(0);
  expect(requests).toHaveLength(0);
});

test("structured output repair retains signed assistant blocks", async () => {
  const { provider } = fixture(2000);
  const requests: AIProviderStreamParams[] = [];
  provider.stream = async function* (params) {
    requests.push(params);
    yield { type: "thinking", content: "reason", signature: "signed" };
    yield {
      type: "tool_use",
      id: `call${requests.length}`,
      name: "respond",
      input: { valid: requests.length > 1 },
    };
    yield { type: "done" };
  };
  await generateObjectAI({
    ...request,
    provider,
    schema: {},
    validate: (input: any) => {
      if (!input.valid) throw new Error("repair");
      return input;
    },
  });
  expect(JSON.stringify(requests[1]?.messages)).toContain(
    '"signature":"signed"',
  );
});

test("stored-source recovery retires only older repeatable lookups and preserves the latest evidence", async () => {
  const { createAIStoredToolResultRecovery } =
    await import("../src/ai/storedToolResultRecovery");
  const { provider } = fixture(2100);
  const messages: AIProviderMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "old",
          name: "read_source",
          input: { version: "v1", start: 0 },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "old",
          content: "old".repeat(1000),
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "write", name: "save", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "write",
          content: "receipt: saved once",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "new",
          name: "read_source",
          input: { version: "v1", start: 100 },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "new",
          content: "Actual corrected budget: £17,431.29",
        },
      ],
    },
  ];
  const result = await generateAI({
    ...request,
    provider,
    messages,
    contextPolicy: {
      recover: createAIStoredToolResultRecovery(["read_source"]),
    },
  });
  const history = JSON.stringify(result.requestMessages);
  expect(history).toContain("Earlier lookup removed from working context");
  expect(history).toContain("Actual corrected budget: £17,431.29");
  expect(history).toContain("receipt: saved once");
  expect(history).toContain('"version":"v1"');
  expect(JSON.stringify(messages)).toContain("old".repeat(1000));
});

test("system prompts, images and tool result identities are protected from recovery edits", async () => {
  const { provider } = fixture(400);
  const base: AIProviderMessage[] = [
    { role: "system", content: "Never change instructions" },
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "url",
            url: "https://example.test/image.png",
            media_type: "image/png",
          },
        },
        { type: "text", content: "x".repeat(1000) },
      ],
    },
  ];
  for (const mutate of [
    (messages: any[]) => {
      messages[0].content = "Changed";
    },
    (messages: any[]) => {
      messages[1].content[0].source.url = "https://example.test/other.png";
    },
  ])
    await expect(
      collect(
        streamWithAIContext(
          provider,
          { ...request, messages: base },
          {
            recover: async ({ params }) => {
              mutate(params.messages);
              (params.messages[1]!.content as any[])[1].content = "short";
              return params.messages;
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "unsupported_content" });
});

for (const transport of ["sse", "websocket"] as const)
  test(`${transport} preserves protected provider blocks through recovered tool turns`, async () => {
    const { provider } = fixture(1400);
    const requests: AIProviderStreamParams[] = [];
    provider.stream = async function* (params) {
      requests.push(structuredClone({ ...params, signal: undefined }));
      const turn = requests.length;
      if (turn <= 2) {
        yield {
          type: "thinking",
          content: `reason${turn}`,
          signature: `signed${turn}`,
        };
        yield {
          type: "provider_event",
          provider: "test",
          data: { opaque: `native${turn}` },
        };
        yield {
          type: "tool_use",
          name: "read",
          id: `read${turn}`,
          input: { turn },
        };
      } else yield { type: "text", content: "Finished" };
      yield { type: "done" };
    };
    let effects = 0;
    const options = {
      ...request,
      provider,
      contextPolicy: {
        recover: async ({ params }: { params: AIProviderStreamParams }) =>
          params.messages.map((message) => ({
            ...message,
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map((block) =>
                    block.type === "tool_result"
                      ? { ...block, content: "saved notes" }
                      : block,
                  ),
          })),
      },
      tools: {
        read: {
          description: "read",
          input: {},
          handler: () => {
            effects++;
            return "x".repeat(1500);
          },
        },
      },
    };
    if (transport === "sse")
      await collect(streamAIToSSE("c", "m", options, resolveRenderers()));
    else
      await streamAI(
        { readyState: 1, send: () => undefined },
        "c",
        "m",
        options,
      );
    expect(effects).toBe(2);
    expect(requests).toHaveLength(3);
    const history = JSON.stringify(requests[2]?.messages);
    expect(history).toContain("signed1");
    expect(history).toContain("signed2");
    expect(history).toContain("native1");
    expect(history).toContain("native2");
  });

test("provider errors from separately bundled entrypoints keep their typed contract", async () => {
  class OtherProviderError extends Error {
    name = "ProviderError";
    status = 400;
    type = null;
    provider = "openai";
    metadata = { code: "context_length_exceeded" };
  }
  expect(isAIContextRejection(new OtherProviderError("Capacity"))).toBe(true);
  class OtherInputError extends Error {
    name = "AIInputError";
    code = "capacity_unavailable";
  }
  const { provider } = fixture();
  provider.inputCapacity!.getLimits = async () => {
    throw new OtherInputError("Unknown model");
  };
  const { AIInputError } = await import("../src/ai/inputCapacity");
  await expect(generateAI({ ...request, provider })).rejects.toBeInstanceOf(
    AIInputError,
  );
});
