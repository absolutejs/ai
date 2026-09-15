import { describe, expect, test } from "bun:test";
import { inspectAIInput, AIInputError } from "../src/ai/inputCapacity";
import { prepareAITextInput } from "../src/ai/prepareTextInput";
import { anthropic } from "../src/ai/providers/anthropic";
import { gemini } from "../src/ai/providers/gemini";
import { openaiResponses } from "../src/ai/providers/openaiResponses";
import type { AIProviderConfig, AIProviderStreamParams } from "../types/ai";

const textProvider = (capacity = 2000) => {
  const sections: string[] = [];
  const count = (params: AIProviderStreamParams) =>
    JSON.stringify(params).length;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: capacity,
        maxOutputTokens: 100,
        contextWindowTokens: capacity,
      }),
      countTokens: async (params) => count(params),
    },
    stream: async function* (params) {
      expect(count(params) + (params.maxTokens ?? 0)).toBeLessThanOrEqual(
        capacity,
      );
      const data = JSON.parse(String(params.messages[0]?.content));
      sections.push(data.sourceSection);
      yield { type: "text", content: "Factual notes." };
      yield {
        type: "done",
        usage: { inputTokens: count(params), outputTokens: 5 },
      };
    },
  };
  return { provider, sections };
};

describe("provider-owned input capacity", () => {
  test("reserves output and includes prompt/tool tokens; no 10k character gate", async () => {
    const { provider } = textProvider(50000);
    const params = {
      model: "test",
      maxTokens: 100,
      messages: [{ role: "user" as const, content: "a".repeat(12000) }],
    };
    expect((await inspectAIInput(provider, params)).fits).toBe(true);
    expect((await prepareAITextInput(provider, params)).params).toBe(params);
    expect(
      (await inspectAIInput(provider, { ...params, maxTokens: 101 })).fits,
    ).toBe(false);
  });
  test("reads every character including Unicode in order, preserves source, meters sections", async () => {
    const { provider, sections } = textProvider();
    const source = "中文🙂".repeat(1800);
    const params = {
      model: "test",
      systemPrompt: "Extract all intake facts",
      maxTokens: 100,
      messages: [{ role: "user" as const, content: source }],
    };
    let metered = 0;
    const result = await prepareAITextInput(provider, params, {
      onUsage: () => {
        metered++;
      },
    });
    expect(result.compacted).toBe(true);
    expect(sections.join("")).toBe(`user: ${source}`);
    expect(params.messages[0]?.content).toBe(source);
    expect(metered).toBe(result.sectionsProcessed);
    expect((await inspectAIInput(provider, result.params)).fits).toBe(true);
  });
  test("unknown providers fail explicitly instead of inventing a limit", async () => {
    await expect(
      inspectAIInput(
        { stream: async function* () {} },
        { model: "unknown", messages: [] },
      ),
    ).rejects.toBeInstanceOf(AIInputError);
  });
  test("aborts before counting or reading sections", async () => {
    const { provider } = textProvider();
    await expect(
      prepareAITextInput(provider, {
        model: "test",
        messages: [],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });
  test("Anthropic resolves the exact model and counts serialized system, tools and messages", async () => {
    const requests: Array<{ url: string; body: any; headers: Headers }> = [];
    const provider = anthropic({
      apiKey: "test",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
          headers: new Headers(init?.headers),
        });
        return Response.json(
          String(url).includes("count_tokens")
            ? { input_tokens: 901 }
            : { max_input_tokens: 1000, max_tokens: 200 },
        );
      },
    });
    const params = {
      model: "claude-exact-alias",
      messages: [{ role: "user" as const, content: "answer" }],
      systemPrompt: "system",
      maxTokens: 100,
      tools: [
        {
          name: "finish",
          description: "finish",
          input_schema: { type: "object" },
        },
      ],
    };
    expect((await inspectAIInput(provider, params)).fits).toBe(false);
    expect(requests[0]?.url).toEndWith("/v1/models/claude-exact-alias");
    const counted = requests.find((request) => request.body);
    expect(counted?.body.tools[0].name).toBe("finish");
    expect(counted?.body.system).toBeDefined();
    expect(counted?.body.max_tokens).toBeUndefined();
    expect(counted?.headers.get("x-api-key")).toBe("test");
    await inspectAIInput(provider, params);
    expect(requests.filter((request) => !request.body)).toHaveLength(1);
  });
  test("Gemini uses separate input/output limits and full generateContentRequest", async () => {
    let request: any;
    const provider = gemini({
      apiKey: "test",
      fetch: (async (url: string, init: RequestInit) => {
        request = init.body ? JSON.parse(String(init.body)) : null;
        return Response.json(
          url.includes("countTokens")
            ? { totalTokens: 999 }
            : { inputTokenLimit: 1000, outputTokenLimit: 200 },
        );
      }) as typeof fetch,
    });
    expect(
      (
        await inspectAIInput(provider, {
          model: "gemini-test",
          maxTokens: 200,
          systemPrompt: "system",
          messages: [],
        })
      ).fits,
    ).toBe(true);
    expect(request.generateContentRequest.systemInstruction.parts[0].text).toBe(
      "system",
    );
  });
  test("OpenAI uses token counting and documented model-specific context", async () => {
    let body: any;
    const provider = openaiResponses({
      apiKey: "test",
      fetch: (async (_url: unknown, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return Response.json({ input_tokens: 127950 });
      }) as typeof fetch,
    });
    const capacity = await inspectAIInput(provider, {
      model: "gpt-4o",
      maxTokens: 100,
      systemPrompt: "system",
      messages: [],
    });
    expect(capacity.fits).toBe(false);
    expect(body.instructions).toBe("system");
    expect(body.max_output_tokens).toBeUndefined();
  });
  test("invalid provider metadata cannot be treated as unlimited capacity", async () => {
    const provider = anthropic({
      apiKey: "test",
      fetch: async () =>
        Response.json({
          max_input_tokens: null,
          max_tokens: 100,
          input_tokens: 5,
        }),
    });
    await expect(
      inspectAIInput(provider, { model: "unknown", messages: [] }),
    ).rejects.toBeInstanceOf(AIInputError);
  });
});

describe("capacity failure recovery", () => {
  test("unknown OpenAI snapshots cannot inherit another model's limits", async () => {
    const provider = openaiResponses({
      apiKey: "test",
      fetch: async () => Response.json({ input_tokens: 1 }),
    });
    await expect(
      inspectAIInput(provider, {
        model: "gpt-4o-unverified-snapshot",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "capacity_unavailable" });
  });
  test("truncated document notes fail without changing the saved source", async () => {
    const { provider } = textProvider();
    provider.stream = async function* () {
      yield { type: "text", content: "Incomplete notes" };
      yield { type: "done", stopReason: "max_tokens" };
    };
    const source = "Original answer ".repeat(1000);
    const params = {
      model: "test",
      maxTokens: 100,
      messages: [{ role: "user" as const, content: source }],
    };
    await expect(prepareAITextInput(provider, params)).rejects.toMatchObject({
      code: "capacity_unavailable",
    });
    expect(params.messages[0]?.content).toBe(source);
  });
  test("failed metadata is retried instead of cached as missing capacity", async () => {
    let failed = true;
    const provider = anthropic({
      apiKey: "test",
      fetch: async (url) => {
        if (String(url).includes("count_tokens"))
          return Response.json({ input_tokens: 10 });
        return failed
          ? new Response("unavailable", { status: 503 })
          : Response.json({ max_input_tokens: 1000, max_tokens: 100 });
      },
    });
    const params = { model: "test", maxTokens: 100, messages: [] };
    await expect(inspectAIInput(provider, params)).rejects.toMatchObject({
      code: "capacity_unavailable",
    });
    failed = false;
    expect((await inspectAIInput(provider, params)).fits).toBe(true);
  });
});

test("counts transformed OpenAI reply budgets against the context window", async () => {
  const provider = openaiResponses({
    apiKey: "test",
    transformRequestBody: (body) => ({ ...body, max_output_tokens: 1000 }),
    fetch: async () => Response.json({ input_tokens: 127500 }),
  });
  const capacity = await inspectAIInput(provider, {
    model: "gpt-4o",
    maxTokens: 100,
    messages: [],
  });
  expect(capacity.outputTokens).toBe(1000);
  expect(capacity.fits).toBe(false);
});
