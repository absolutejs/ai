import { expect, test } from "bun:test";
import {
  getModelMetadata,
  getModelReasoning,
  modelCapabilities,
} from "./index";
test("unknown models do not inherit capabilities from a similar ID", () => {
  expect(
    modelCapabilities(getModelMetadata("openai", "gpt-6-astra-custom")),
  ).toEqual([]);
});
test("image understanding does not imply generation", () => {
  const badges = modelCapabilities(getModelMetadata("openai", "gpt-6-astra"));
  expect(badges).toContain("Vision");
  expect(badges).not.toContain("Image generation");
  expect(badges).not.toContain("Audio");
});
test("Gemini distinguishes audio/video input from output", () => {
  const badges = modelCapabilities(
    getModelMetadata("google", "gemini-3.8-flash"),
  );
  expect(badges).toContain("Audio");
  expect(badges).toContain("Video");
  expect(badges).not.toContain("Speech generation");
  expect(badges).not.toContain("Video generation");
});
test("Haiku reasoning is not lost behind the fast label", () => {
  expect(
    modelCapabilities(getModelMetadata("anthropic", "claude-haiku-4-5")),
  ).toContain("Reasoning");
});
test("directory keys are unique and Anthropic/OpenAI entries have reviewed metadata", async () => {
  const { MODEL_DIRECTORY, modelKey } = await import("./index");
  const keys = MODEL_DIRECTORY.map(modelKey);
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of MODEL_DIRECTORY.filter((e) =>
    ["anthropic", "openai"].includes(e.provider),
  ))
    expect(getModelMetadata(entry.provider, entry.id)).toBeDefined();
});
test("listModels hides legacy models unless asked and filters providers", async () => {
  const { listModels } = await import("./index");
  const current = listModels({ providers: ["anthropic", "openai"] });
  expect(
    current.every((m) => ["anthropic", "openai"].includes(m.provider)),
  ).toBe(true);
  expect(current.some((m) => m.legacy)).toBe(false);
  expect(current.find((m) => m.id === "claude-opus-5-5")).toMatchObject({
    key: "anthropic:claude-opus-5-5",
    providerName: "Anthropic",
    contextWindow: 1000000,
  });
  const all = listModels({ providers: ["anthropic"], includeLegacy: true });
  expect(all.map((m) => m.id)).toContain("claude-sonnet-4-5");
  expect(all.length).toBeGreaterThan(
    current.filter((m) => m.provider === "anthropic").length,
  );
});
test("Opus 5.5 exposes Models API effort levels", () => {
  expect(getModelReasoning("anthropic", "claude-opus-5-5")?.efforts).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(getModelReasoning("anthropic", "claude-opus-4-5")?.efforts).toEqual([
    "low",
    "medium",
    "high",
  ]);
});
