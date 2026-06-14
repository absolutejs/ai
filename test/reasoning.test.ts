import { describe, expect, test } from "bun:test";
import {
  anthropicEffortValue,
  anthropicReasoningMode,
  anthropicSupportsSampling,
  isOpenAIReasoningModel,
  openaiEffortValue,
  resolveBudgetTokens,
  resolveEffort,
} from "../src/ai/providers/reasoning";

describe("anthropicReasoningMode", () => {
  test("modern effort models", () => {
    expect(anthropicReasoningMode("claude-opus-4-8")).toBe("effort");
    expect(anthropicReasoningMode("claude-opus-4-6")).toBe("effort");
    expect(anthropicReasoningMode("claude-sonnet-4-6")).toBe("effort");
    expect(anthropicReasoningMode("claude-fable-5")).toBe("effort");
    expect(anthropicReasoningMode("claude-opus-4-5")).toBe("effort");
  });
  test("legacy budget models", () => {
    expect(anthropicReasoningMode("claude-sonnet-4-5-20250929")).toBe("legacy");
    expect(anthropicReasoningMode("claude-opus-4-1-20250805")).toBe("legacy");
    expect(anthropicReasoningMode("claude-sonnet-4-20250514")).toBe("legacy");
    expect(anthropicReasoningMode("claude-3-7-sonnet-20250219")).toBe("legacy");
  });
  test("no-op models (incl. Haiku 4.5, which rejects effort + unconfirmed adaptive)", () => {
    expect(anthropicReasoningMode("claude-haiku-4-5")).toBe("none");
    expect(anthropicReasoningMode("claude-3-5-haiku-20241022")).toBe("none");
  });
});

describe("anthropicSupportsSampling", () => {
  test("4.7/4.8/Fable reject sampling params", () => {
    expect(anthropicSupportsSampling("claude-opus-4-8")).toBe(false);
    expect(anthropicSupportsSampling("claude-opus-4-7")).toBe(false);
    expect(anthropicSupportsSampling("claude-fable-5")).toBe(false);
  });
  test("4.6 and older accept sampling params", () => {
    expect(anthropicSupportsSampling("claude-opus-4-6")).toBe(true);
    expect(anthropicSupportsSampling("claude-sonnet-4-6")).toBe(true);
    expect(anthropicSupportsSampling("claude-sonnet-4-5-20250929")).toBe(true);
    expect(anthropicSupportsSampling("claude-haiku-4-5")).toBe(true);
  });
});

describe("anthropicEffortValue", () => {
  test("passes through supported effort", () => {
    expect(anthropicEffortValue("claude-opus-4-8", { effort: "high" })).toBe(
      "high",
    );
    expect(anthropicEffortValue("claude-opus-4-8", { effort: "max" })).toBe(
      "max",
    );
  });
  test("clamps minimal up to low (Anthropic has no minimal)", () => {
    expect(anthropicEffortValue("claude-opus-4-8", { effort: "minimal" })).toBe(
      "low",
    );
  });
  test("clamps max down to high on models without the max tier (4.5)", () => {
    expect(anthropicEffortValue("claude-opus-4-5", { effort: "max" })).toBe(
      "high",
    );
  });
});

describe("openai reasoning", () => {
  test("classifies reasoning models", () => {
    expect(isOpenAIReasoningModel("o3")).toBe(true);
    expect(isOpenAIReasoningModel("o4-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-4.1")).toBe(false);
    expect(isOpenAIReasoningModel("gpt-4o")).toBe(false);
  });
  test("effort only on reasoning models", () => {
    expect(openaiEffortValue("gpt-4.1", { effort: "high" })).toBeNull();
    expect(openaiEffortValue("o3", { effort: "high" })).toBe("high");
  });
  test("max clamps to high (OpenAI has no max)", () => {
    expect(openaiEffortValue("o3", { effort: "max" })).toBe("high");
  });
  test("minimal only on gpt-5; clamps to low elsewhere", () => {
    expect(openaiEffortValue("gpt-5", { effort: "minimal" })).toBe("minimal");
    expect(openaiEffortValue("o3", { effort: "minimal" })).toBe("low");
  });
});

describe("effort <-> budget cross-derivation", () => {
  test("effort derives a legacy budget", () => {
    expect(resolveBudgetTokens({ effort: "low" })).toBe(2048);
    expect(resolveBudgetTokens({ effort: "high" })).toBe(16384);
  });
  test("explicit budget wins", () => {
    expect(resolveBudgetTokens({ budgetTokens: 5000, effort: "high" })).toBe(
      5000,
    );
  });
  test("budget derives an effort for effort-based models", () => {
    expect(resolveEffort({ budgetTokens: 1500 })).toBe("low");
    expect(resolveEffort({ budgetTokens: 10000 })).toBe("high");
    expect(resolveEffort({ effort: "medium" })).toBe("medium");
  });
});
