import type {
  AIProviderStreamParams,
  AIResponseMetadata,
  AIUsage,
} from "./ai";

export type AnthropicConfig = {
  apiKey?: string;
  /** Authentication wire format. Defaults to Anthropic's `x-api-key`. */
  authStyle?: "anthropic" | "bearer";
  baseUrl?: string;
  /** Injectable transport for policy, tracing, testing, and private egress. */
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  maxTokens?: number;
  headers?:
    | HeadersInit
    | ((params: AIProviderStreamParams) => HeadersInit | Promise<HeadersInit>);
  providerName?: string;
  /**
   * Enable Anthropic prompt caching breakpoints (tools + system + rolling
   * message prefix). Defaults to `true`. Caching is a silent no-op below the
   * minimum cacheable prefix, so small requests are unaffected. Set `false` to
   * disable entirely.
   */
  promptCaching?: boolean;
  tokenSource?: () => Promise<string> | string;
  transformRequestBody?: (
    body: Record<string, unknown>,
    params: AIProviderStreamParams,
  ) => Record<string, unknown>;
};

export type AnthropicMessage = {
  content: string | Array<Record<string, unknown>>;
  role: "user" | "assistant";
};

export type AnthropicSSEState = {
  buffer: string;
  currentProviderBlock?: Record<string, unknown>;
  currentToolId: string;
  currentToolName: string;
  isThinkingBlock: boolean;
  stopReason: string;
  thinkingSignature: string;
  toolInputJson: string;
  usage: AIUsage | undefined;
  metadata?: AIResponseMetadata;
  providerName: string;
  providerBlockInputJson: string;
};
