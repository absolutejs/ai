/** Client-safe model discovery. Missing metadata means unknown, never unsupported. */
export type ModelModality = "text" | "image" | "pdf" | "audio" | "video";
export type ModelFeature =
  | "reasoning"
  | "tools"
  | "structured-output"
  | "prompt-cache"
  | "web-search";
export type ModelMetadata = {
  input: readonly ModelModality[];
  output: readonly ModelModality[];
  features: readonly ModelFeature[];
  contextWindow?: number;
  sources: readonly string[];
  reviewedAt: string;
};
export const MODEL_CAPABILITY_DESCRIPTIONS = {
  Fast: "Suited to quick edits and lightweight tasks; actual speed varies with the request.",
  Reasoning: "Can spend extra thinking time on complex problems.",
  Tools:
    "Supports function calls for actions such as inspecting and editing code.",
  Vision: "Understands images. This does not mean it generates images.",
  PDF: "Accepts PDF documents, including their text and visual content.",
  Audio: "Understands audio input. This does not mean it generates speech.",
  Video: "Understands video input. This does not mean it generates videos.",
  "Image generation": "Produces images as model output.",
  "Speech generation": "Produces audio as model output.",
  "Video generation": "Produces video as model output.",
  Structured:
    "Supports schema-constrained output for reliable structured data.",
  Caching:
    "The provider can reuse matching prompt content to reduce repeated processing. Cache hits are not guaranteed.",
  Search:
    "Supports a provider-hosted web-search tool when enabled by the application.",
  "Long context":
    "A documented context window of at least 200,000 tokens. Application and request limits may be lower.",
} as const;
export type ModelCapability = keyof typeof MODEL_CAPABILITY_DESCRIPTIONS;
const INPUT_BADGES: Partial<Record<ModelModality, ModelCapability>> = {
  image: "Vision",
  pdf: "PDF",
  audio: "Audio",
  video: "Video",
};
const OUTPUT_BADGES: Partial<Record<ModelModality, ModelCapability>> = {
  image: "Image generation",
  audio: "Speech generation",
  video: "Video generation",
};
const FEATURE_BADGES: Record<ModelFeature, ModelCapability> = {
  reasoning: "Reasoning",
  tools: "Tools",
  "structured-output": "Structured",
  "prompt-cache": "Caching",
  "web-search": "Search",
};
/** Derive badges from explicit evidence; do not infer support from model names. */
export const modelCapabilities = (
  metadata?: ModelMetadata,
): ModelCapability[] => {
  if (!metadata) return [];
  const badges = new Set<ModelCapability>();
  for (const feature of metadata.features) badges.add(FEATURE_BADGES[feature]);
  for (const input of metadata.input) {
    const badge = INPUT_BADGES[input];
    if (badge) badges.add(badge);
  }
  for (const output of metadata.output) {
    const badge = OUTPUT_BADGES[output];
    if (badge) badges.add(badge);
  }
  if (metadata.contextWindow && metadata.contextWindow >= 200_000)
    badges.add("Long context");
  return [...badges];
};
export { MODEL_METADATA, getModelMetadata } from "./catalog";

export {
  MODEL_REASONING,
  REASONING_EFFORTS,
  getModelReasoning,
  isReasoningSelection,
  supportsReasoningSelection,
  reasoningSelectionLabel,
  type ModelReasoning,
  type ReasoningSelection,
} from "./reasoning";
