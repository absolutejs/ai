import { describe, expect, test } from "bun:test";
import { generateObjectAI } from "../src/ai/generateAI";
import type { AIChunk, AIProviderConfig } from "../types/ai";

// A provider that always makes the forced tool call, returning the next `input`
// from the list on each stream() invocation (last entry repeats). `calls` counts
// how many generations ran so tests can assert the repair loop's behaviour.
const toolProvider = (
  toolName: string,
  inputs: unknown[],
): AIProviderConfig & { calls: number } => {
  const state = { calls: 0 };

  return {
    get calls() {
      return state.calls;
    },
    stream: () =>
      (async function* () {
        const input = inputs[Math.min(state.calls, inputs.length - 1)];
        state.calls += 1;
        yield {
          id: `t${state.calls}`,
          input,
          name: toolName,
          type: "tool_use",
        } as AIChunk;
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as AIChunk;
      })(),
  };
};

// Reject names longer than `max`; otherwise narrow to { name }.
const nameValidator = (max: number) => (raw: unknown) => {
  const name = (raw as { name?: unknown }).name;
  if (typeof name !== "string" || name.length > max)
    throw new Error(`name must be <= ${max} chars`);

  return { name };
};

describe("generateObjectAI repair loop", () => {
  test("re-prompts on validation failure and returns the corrected output", async () => {
    const provider = toolProvider("respond", [
      { name: "x".repeat(50) }, // too long → validate throws
      { name: "fixed" }, // corrected on the repair pass
    ]);

    const { object } = await generateObjectAI({
      messages: [],
      model: "test",
      provider,
      schema: {},
      toolName: "respond",
      validate: nameValidator(10),
    });

    expect(object).toEqual({ name: "fixed" });
    expect(provider.calls).toBe(2); // initial + one default repair attempt
  });

  test("maxRepairAttempts: 0 keeps strict single-attempt behaviour", async () => {
    const provider = toolProvider("respond", [{ name: "x".repeat(50) }]);

    await expect(
      generateObjectAI({
        maxRepairAttempts: 0,
        messages: [],
        model: "test",
        provider,
        schema: {},
        toolName: "respond",
        validate: nameValidator(10),
      }),
    ).rejects.toThrow("name must be <= 10 chars");
    expect(provider.calls).toBe(1);
  });

  test("gives up after maxRepairAttempts and throws the last validation error", async () => {
    const provider = toolProvider("respond", [{ name: "always-too-long" }]);

    await expect(
      generateObjectAI({
        maxRepairAttempts: 2,
        messages: [],
        model: "test",
        provider,
        schema: {},
        toolName: "respond",
        validate: nameValidator(5),
      }),
    ).rejects.toThrow("name must be <= 5 chars");
    expect(provider.calls).toBe(3); // initial + 2 repairs
  });

  test("accumulates usage across repair attempts", async () => {
    const provider = toolProvider("respond", [
      { name: "x".repeat(50) },
      { name: "ok" },
    ]);

    const { usage } = await generateObjectAI({
      messages: [],
      model: "test",
      provider,
      schema: {},
      toolName: "respond",
      validate: nameValidator(10),
    });

    // Two generations, each reporting 1 in / 1 out.
    expect(usage?.inputTokens).toBe(2);
    expect(usage?.outputTokens).toBe(2);
  });
});
