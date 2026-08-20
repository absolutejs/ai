// Structured provider error. Replaces the previous `throw new Error("Anthropic
// API error 529: ...")` strings so consumers can classify outages
// programmatically (retryable? which provider? what status?) instead of parsing
// message text. Surfaced both by the retry/circuit-breaker layer and to end
// callers via `instanceof ProviderError`.

// Public status pages (also serve the Atlassian Statuspage JSON API at
// /api/v2/*), keyed by the provider name passed to the factories. Anthropic
// moved theirs to status.claude.com — status.anthropic.com only HTTP-redirects,
// which breaks JSON polling, so we point at the canonical host.
export const PROVIDER_STATUS_PAGES: Record<string, string> = {
  anthropic: "https://status.claude.com",
  gemini: "https://status.cloud.google.com",
  google: "https://status.cloud.google.com",
  openai: "https://status.openai.com",
  openrouter: "https://status.openrouter.ai",
};

// HTTP statuses that mean "the provider is unavailable / overloaded / rate
// limited", i.e. retrying later may succeed — NOT a malformed request. 529 is
// Anthropic's "overloaded". 4xx auth/validation (400/401/403/404/422) are
// deliberately excluded: those are the caller's fault and never self-heal.
const RETRYABLE_STATUSES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 529,
]);

// Connection-level failure fingerprints (fetch rejects before any HTTP status).
const CONNECTION_ERROR_PATTERNS = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "network",
  "terminated",
  "timed out",
  "timeout",
  "and not retryable",
  "no response body",
];

const isAbortError = (err: unknown): boolean =>
  err instanceof Error &&
  (err.name === "AbortError" || /\babort(ed)?\b/i.test(err.message));

/** Public status page for a provider, or null when we don't track one. */
export const providerStatusPage = (provider: string): string | null =>
  PROVIDER_STATUS_PAGES[provider] ?? null;

export type ProviderErrorInit = {
  provider: string;
  message: string;
  status?: number | null;
  /** Provider-specific error type, e.g. Anthropic's "overloaded_error". */
  type?: string | null;
  retryable: boolean;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly provider: string;
  /** HTTP status when the failure carried one; null for connection errors. */
  readonly status: number | null;
  readonly type: string | null;
  /** Whether retrying the same request later could plausibly succeed. */
  readonly retryable: boolean;
  /** Provider status page, when known — for surfacing "is it them?" to users. */
  readonly statusPageUrl: string | null;

  constructor(init: ProviderErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "ProviderError";
    this.provider = init.provider;
    this.status = init.status ?? null;
    this.type = init.type ?? null;
    this.retryable = init.retryable;
    this.statusPageUrl = providerStatusPage(init.provider);
  }

  /** Build from a non-2xx HTTP response (status + body text are known). */
  static fromResponse(
    provider: string,
    status: number,
    body: string,
    type?: string | null,
  ): ProviderError {
    return new ProviderError({
      message: `${capitalize(provider)} API error ${status}: ${body}`,
      provider,
      retryable: RETRYABLE_STATUSES.has(status),
      status,
      type: type ?? null,
    });
  }

  /**
   * Normalize any thrown value into a ProviderError. Passes existing
   * ProviderErrors through unchanged; classifies connection errors and
   * status-bearing message strings; rethrows aborts to the caller (an aborted
   * request is the caller's intent, never a provider outage).
   */
  static from(err: unknown, provider: string): ProviderError {
    if (err instanceof ProviderError) return err;
    if (isAbortError(err)) throw err;

    const rawMessage = err instanceof Error ? err.message : String(err ?? "");
    const lower = rawMessage.toLowerCase();

    const statusMatch = lower.match(/api error\s+(\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : null;

    const retryable =
      (status !== null && RETRYABLE_STATUSES.has(status)) ||
      (status === null &&
        CONNECTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern)));

    return new ProviderError({
      cause: err,
      message: rawMessage || `${capitalize(provider)} request failed`,
      provider,
      retryable,
      status,
    });
  }
}

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);
