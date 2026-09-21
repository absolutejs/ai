import { expect, test } from "bun:test";
import { getModelMetadata, modelCapabilities } from "./index";
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
