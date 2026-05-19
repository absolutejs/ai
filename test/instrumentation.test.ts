import { describe, expect, test } from "bun:test";
import { instrumentAIProvider } from "../src/ai/providers/instrumentation";
import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../types/ai";

const fakeProvider = (chunks: AIChunk[]): AIProviderConfig => ({
  stream: () =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
});

const drain = async (iter: AsyncIterable<AIChunk>) => {
  const out: AIChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
};

describe("instrumentAIProvider", () => {
  test("returns the stream untouched when neither onUsage nor onSpan is set", async () => {
    const inner = fakeProvider([
      { content: "hi", type: "text" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    const wrapped = instrumentAIProvider(inner, "openai");
    const chunks = await drain(
      wrapped.stream({ messages: [], model: "test" } as AIProviderStreamParams),
    );
    expect(chunks).toHaveLength(2);
  });

  test("invokes onUsage with the AIDoneChunk usage payload + model + provider", async () => {
    const inner = fakeProvider([
      { content: "hello", type: "text" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4 } },
    ]);
    const wrapped = instrumentAIProvider(inner, "openai");
    const onUsage = (data: { inputTokens: number; outputTokens: number; model: string; provider?: string }) => {
      lastUsage = data;
    };
    let lastUsage: { inputTokens: number; outputTokens: number; model: string; provider?: string } | undefined;
    await drain(
      wrapped.stream({
        messages: [],
        model: "gpt-4o-mini",
        onUsage,
      } as unknown as AIProviderStreamParams),
    );
    expect(lastUsage).toEqual({
      inputTokens: 10,
      model: "gpt-4o-mini",
      outputTokens: 4,
      provider: "openai",
    });
  });

  test("invokes onSpan with durationMs after the stream completes", async () => {
    const inner = fakeProvider([
      { content: "hello", type: "text" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const wrapped = instrumentAIProvider(inner, "openai");
    let span:
      | {
          durationMs: number;
          model: string;
          provider?: string;
          usage?: { inputTokens: number; outputTokens: number };
        }
      | undefined;
    await drain(
      wrapped.stream({
        messages: [],
        model: "gpt-4o-mini",
        onSpan: (s) => {
          span = s;
        },
      } as unknown as AIProviderStreamParams),
    );
    expect(span).toBeDefined();
    expect(span!.model).toBe("gpt-4o-mini");
    expect(span!.provider).toBe("openai");
    expect(span!.durationMs).toBeGreaterThanOrEqual(0);
    expect(span!.usage?.inputTokens).toBe(1);
  });

  test("swallows callback errors to keep stream consumers safe", async () => {
    const inner = fakeProvider([
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const wrapped = instrumentAIProvider(inner, "openai");
    await expect(
      drain(
        wrapped.stream({
          messages: [],
          model: "gpt-4o-mini",
          onUsage: () => {
            throw new Error("boom");
          },
        } as unknown as AIProviderStreamParams),
      ),
    ).resolves.toBeDefined();
  });
});
