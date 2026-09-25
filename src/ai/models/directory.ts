import { getModelMetadata } from "./catalog";
import { getModelReasoning } from "./reasoning";
import { modelCapabilities } from "./index";

/** Display names for the providers the directory covers. */
export const MODEL_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  alibaba: "Alibaba",
  moonshot: "Moonshot AI",
  meta: "Meta",
};

export type ModelDirectoryEntry = {
  provider: string;
  /** The exact model ID sent to the provider. */
  id: string;
  name: string;
  /** One short, plain sentence for pickers. */
  description: string;
  /** A current flagship worth showing first. */
  featured?: boolean;
  /** Superseded by a newer model in the same line; hide by default. */
  legacy?: boolean;
};

/**
 * Human-facing model directory for pickers, newest first within each provider.
 * Capabilities and context windows come from MODEL_METADATA, not from here.
 * Anthropic entries were checked against the Models API on 2026-09-25.
 */
export const MODEL_DIRECTORY: readonly ModelDirectoryEntry[] = [
  {
    provider: "anthropic",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "Anthropic’s newest Opus, for the most demanding work.",
    featured: true,
  },
  {
    provider: "anthropic",
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    description: "Deep reasoning and long-running agentic work.",
    featured: true,
  },
  {
    provider: "anthropic",
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "Complex coding and ambitious projects.",
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "Balanced speed and intelligence.",
    featured: true,
  },
  {
    provider: "anthropic",
    id: "claude-fable-5",
    name: "Claude Fable 5",
    description: "The earlier Fable release.",
    legacy: true,
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    description: "The last Opus 4 release.",
    legacy: true,
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    description: "An earlier Opus 4 release.",
    legacy: true,
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description: "Dependable everyday work.",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    description: "Detailed coding and architecture.",
    legacy: true,
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    description: "Quick, focused tasks.",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    description: "Older generation, kept for compatibility.",
    legacy: true,
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    description: "Older generation, kept for compatibility.",
    legacy: true,
  },
  {
    provider: "openai",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    description: "Frontier reasoning for demanding work.",
    featured: true,
  },
  {
    provider: "openai",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Complex professional and coding work.",
  },
  {
    provider: "openai",
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    description: "Balances capability and efficiency.",
  },
  {
    provider: "openai",
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description: "Fast, economical everyday work.",
  },
  {
    provider: "google",
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    description: "Fast reasoning and long-horizon software work.",
    featured: true,
  },
  {
    provider: "google",
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    description: "Complex reasoning with multimodal context.",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Efficient, low-latency assistance.",
    legacy: true,
  },
  {
    provider: "xai",
    id: "grok-4.6",
    name: "Grok 4.6",
    description: "Reasoning, code, and agentic tool use.",
    featured: true,
  },
  {
    provider: "deepseek",
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    description: "Efficient reasoning with a large context window.",
    featured: true,
  },
  {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "Detailed reasoning and code generation.",
  },
  {
    provider: "mistral",
    id: "mistral-medium-3-5",
    name: "Mistral Medium 3.5",
    description: "Agentic coding and multimodal work.",
    featured: true,
  },
  {
    provider: "mistral",
    id: "mistral-small-latest",
    name: "Mistral Small",
    description: "Compact, efficient assistance.",
  },
  {
    provider: "alibaba",
    id: "qwen3.8-max",
    name: "Qwen3.8 Max",
    description: "Advanced reasoning from the Qwen family.",
    featured: true,
  },
  {
    provider: "alibaba",
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    description: "Balanced reasoning and everyday work.",
  },
  {
    provider: "moonshot",
    id: "kimi-k3",
    name: "Kimi K3",
    description: "Long-horizon coding and agentic tasks.",
    featured: true,
  },
  {
    provider: "moonshot",
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    description: "Focused coding assistance.",
  },
  {
    provider: "meta",
    id: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    name: "Llama 4 Maverick",
    description: "Hosted multimodal reasoning from Meta.",
    featured: true,
  },
];

export const modelKey = (model: { provider: string; id: string }) =>
  `${model.provider}:${model.id}`;

export type ListedModel = ModelDirectoryEntry & {
  key: string;
  providerName: string;
  capabilities: ReturnType<typeof modelCapabilities>;
  contextWindow: number | null;
  reasoningEfforts: readonly string[];
};

/** Directory entries joined with reviewed metadata, ready for a picker. */
export const listModels = (
  options: { providers?: readonly string[]; includeLegacy?: boolean } = {},
): ListedModel[] =>
  MODEL_DIRECTORY.filter(
    (entry) =>
      (!options.providers || options.providers.includes(entry.provider)) &&
      (options.includeLegacy || !entry.legacy),
  ).map((entry) => {
    const metadata = getModelMetadata(entry.provider, entry.id);
    return {
      ...entry,
      key: modelKey(entry),
      providerName: MODEL_PROVIDERS[entry.provider] ?? entry.provider,
      capabilities: modelCapabilities(metadata),
      contextWindow: metadata?.contextWindow ?? null,
      reasoningEfforts:
        getModelReasoning(entry.provider, entry.id)?.efforts ?? [],
    };
  });

export const findModel = (provider: string, id: string) =>
  MODEL_DIRECTORY.find(
    (entry) => entry.provider === provider && entry.id === id,
  );
