import { expect, test } from "bun:test";
import {
  prepareAITextInput,
  prepareAITextInputStep,
  type AITextPreparationCheckpoint,
} from "../src/ai/prepareTextInput";
import type { AIProviderConfig } from "../types/ai";
const setup = () => {
  let calls = 0;
  const provider: AIProviderConfig = {
    inputCapacity: {
      getLimits: async () => ({
        maxInputTokens: 2400,
        contextWindowTokens: 2400,
        maxOutputTokens: 100,
      }),
      countTokens: async (params) => JSON.stringify(params).length,
    },
    stream: async function* () {
      calls++;
      yield {
        type: "text",
        content: "Budget: $17,431.29. Verify original evidence.",
      };
      yield { type: "done" };
    },
  };
  return { provider, calls: () => calls };
};
const params = {
  model: "test",
  maxTokens: 100,
  systemPrompt: "Extract intake facts",
  messages: [
    {
      role: "user" as const,
      content: "Original document information. ".repeat(1000),
    },
  ],
};

test("bounded steps reconstruct the same finished request after persisted restarts", async () => {
  const stepped = setup();
  let checkpoint: AITextPreparationCheckpoint | undefined;
  let finished = false;
  for (let step = 0; step < 100; step++) {
    const before = stepped.calls();
    const result = await prepareAITextInputStep(stepped.provider, params, {
      checkpoint,
    });
    expect(stepped.calls() - before).toBeLessThanOrEqual(1);
    if (result.status === "pending") {
      expect(result.checkpoint.processedCharacters).toBeGreaterThan(
        checkpoint?.processedCharacters ?? 0,
      );
      checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    } else {
      expect(stepped.calls() - before).toBe(0);
      const complete = setup();
      expect(result.prepared).toEqual(
        await prepareAITextInput(complete.provider, params),
      );
      expect(stepped.calls()).toBe(complete.calls());
      finished = true;
      break;
    }
  }
  expect(finished).toBe(true);
});

test("a fitting request is ready without preparation calls", async () => {
  const { provider, calls } = setup();
  const fitting = {
    ...params,
    messages: [{ role: "user" as const, content: "Hello" }],
  };
  const result = await prepareAITextInputStep(provider, fitting);
  expect(result.status).toBe("ready");
  if (result.status === "ready") expect(result.prepared.params).toBe(fitting);
  expect(calls()).toBe(0);
});

test("checkpoint persistence must succeed before a step can return pending", async () => {
  const { provider, calls } = setup();
  await expect(
    prepareAITextInputStep(provider, params, {
      onCheckpoint: async () => {
        throw new Error("attempt no longer owns this job");
      },
    }),
  ).rejects.toThrow("attempt no longer owns this job");
  expect(calls()).toBe(1);
});

test("section provenance survives split messages and mixed conversation roles", async () => {
  const { provider } = setup();
  const sections: Array<{
    sourceSection: string;
    sourceMessageSpans: Array<{
      messageIndex: number;
      role: string;
      start: number;
      end: number;
    }>;
  }> = [];
  provider.stream = async function* (request) {
    sections.push(JSON.parse(String(request.messages[0]!.content)));
    yield { type: "text", content: "Preserved source facts." };
    yield { type: "done" };
  };
  const messages = [
    {
      role: "user" as const,
      content: "Archive. ".repeat(400) + "Final target 137 customers.",
    },
    {
      role: "assistant" as const,
      content: "Earlier assumption: 100 customers.",
    },
    { role: "user" as const, content: "Correction: USD 18001.07." },
  ];
  await prepareAITextInput(provider, { ...params, messages });
  expect(sections.length).toBeGreaterThan(1);
  const expected = messages.map(
    (message) => `${message.role}: ${message.content}`,
  );
  const recovered = messages.map(() => "");
  for (const section of sections) {
    for (const span of section.sourceMessageSpans) {
      expect(span.role).toBe(messages[span.messageIndex]!.role);
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(section.sourceSection.length);
      recovered[span.messageIndex] += section.sourceSection.slice(
        span.start,
        span.end,
      );
    }
  }
  expect(recovered).toEqual(expected);
  expect(
    sections.some((section) => section.sourceMessageSpans.length > 1),
  ).toBe(true);
});

test("checkpoints from the prior preparation policy are reread", async () => {
  const { provider, calls } = setup();
  const first = await prepareAITextInputStep(provider, params);
  expect(first.status).toBe("pending");
  if (first.status !== "pending") throw Error("Expected checkpoint");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        model: params.model,
        systemPrompt: params.systemPrompt,
      }),
    ),
  );
  const priorTaskHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const result = await prepareAITextInputStep(provider, params, {
    checkpoint: {
      ...first.checkpoint,
      taskHash: priorTaskHash,
      notes: "Obsolete notes",
    },
  });
  expect(calls()).toBe(2);
  expect(result.status).toBe("pending");
  if (result.status !== "pending") throw Error("Expected checkpoint");
  expect(result.checkpoint.sectionsProcessed).toBe(1);
  expect(result.checkpoint.processedCharacters).toBe(
    first.checkpoint.processedCharacters,
  );
  expect(result.checkpoint.taskHash).not.toBe(priorTaskHash);
});
