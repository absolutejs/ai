import { expect, test } from "bun:test";
import {
  getModelReasoning,
  supportsReasoningSelection,
} from "../src/ai/models/reasoning";
import {
  compatibleReasoningBody,
  geminiThinkingConfig,
  openaiEffortValue,
  anthropicEffortValue,
} from "../src/ai/providers/reasoning";
test("effort options reflect the named model rather than a universal slider", () => {
  expect(supportsReasoningSelection("openai", "gpt-6-astra", "none")).toBe(
    false,
  );
  expect(supportsReasoningSelection("openai", "gpt-5.6-sol", "none")).toBe(
    true,
  );
  expect(
    supportsReasoningSelection("anthropic", "claude-sonnet-4-6", "xhigh"),
  ).toBe(false);
  expect(getModelReasoning("moonshot", "kimi-k2.7-code")?.efforts).toEqual([]);
  expect(supportsReasoningSelection("custom", "unknown", "high")).toBe(false);
  expect(supportsReasoningSelection("custom", "unknown", "auto")).toBe(true);
});
test("frontier effort passes through without downgrading", () => {
  expect(openaiEffortValue("gpt-6-astra", { effort: "max" })).toBe("max");
  expect(anthropicEffortValue("claude-opus-5", { effort: "xhigh" })).toBe(
    "xhigh",
  );
});
test("compatibility providers receive their actual wire controls", () => {
  expect(
    compatibleReasoningBody("deepseek", "deepseek-flash", { effort: "none" }),
  ).toEqual({ thinking: { type: "disabled" } });
  expect(
    compatibleReasoningBody("alibaba", "qwen3.8-max", { effort: "low" }),
  ).toEqual({ enable_thinking: true, thinking_budget: 2048 });
  expect(
    compatibleReasoningBody("mistral", "mistral-medium-3-5", {
      effort: "high",
    }),
  ).toEqual({ reasoning_effort: "high" });
  expect(
    compatibleReasoningBody("moonshot", "kimi-k3", { effort: "max" }),
  ).toEqual({ reasoning_effort: "max" });
  expect(
    compatibleReasoningBody("xai", "grok-4.6", { effort: "xhigh" }),
  ).toEqual({ reasoning_effort: "xhigh" });
  expect(() =>
    compatibleReasoningBody("mistral", "mistral-small-latest", {
      effort: "medium",
    }),
  ).toThrow();
});
test("Gemini uses levels on 3.x and token budgets on 2.5", () => {
  expect(
    geminiThinkingConfig("gemini-3.1-pro-preview", { effort: "medium" }),
  ).toEqual({ thinkingLevel: "medium" });
  expect(geminiThinkingConfig("gemini-2.5-flash", { effort: "high" })).toEqual({
    thinkingBudget: 24576,
  });
});
