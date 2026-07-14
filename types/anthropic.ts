export type AnthropicConfig = {
  apiKey: string;
  baseUrl?: string;
  /** Injectable transport for policy, tracing, testing, and private egress. */
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  maxTokens?: number;
  /**
   * Enable Anthropic prompt caching breakpoints (tools + system + rolling
   * message prefix). Defaults to `true`. Caching is a silent no-op below the
   * minimum cacheable prefix, so small requests are unaffected. Set `false` to
   * disable entirely.
   */
  promptCaching?: boolean;
};

export type AnthropicMessage = {
  content: string | Array<Record<string, unknown>>;
  role: "user" | "assistant";
};

export type AnthropicSSEState = {
  buffer: string;
  currentToolId: string;
  currentToolName: string;
  isThinkingBlock: boolean;
  stopReason: string;
  thinkingSignature: string;
  toolInputJson: string;
  usage: { inputTokens: number; outputTokens: number } | undefined;
};
