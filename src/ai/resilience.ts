import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../../types/ai";
import { ProviderError, providerStatusPage } from "./errors/providerError";

// Resilience layer wrapped around every provider (via instrumentAIProvider).
// Two behaviours, both automatic:
//
//  1. Bounded retry with exponential backoff on TRANSIENT failures that happen
//     before any chunk is emitted (connection drops, 429/5xx/529). Retrying is
//     only safe pre-first-chunk — once text has streamed to the consumer a retry
//     would duplicate output, so mid-stream failures are surfaced, never retried.
//
//  2. A per-provider circuit breaker. After enough consecutive request failures
//     the circuit OPENS and further calls fail fast (no hammering a provider
//     that's down) until a cooldown elapses, then a single half-open probe
//     decides whether to close. State is exposed via getProviderHealth().
//
// NOTE: state is per-process. Across multiple server instances each process
// keeps its own view — this is best-effort local protection, not a distributed
// breaker. Authoritative "is the provider down" should come from their status
// page; this just stops one process from flogging a dead endpoint.

export type ResilienceConfig = {
  /** Max retry attempts AFTER the first try (so total tries = maxRetries + 1). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Consecutive failed requests before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a half-open probe. */
  openMs: number;
};

const DEFAULT_CONFIG: ResilienceConfig = {
  baseDelayMs: 500,
  failureThreshold: 4,
  maxDelayMs: 8000,
  maxRetries: 2,
  openMs: 30_000,
};

let config: ResilienceConfig = { ...DEFAULT_CONFIG };

/** Override the global resilience defaults (retry counts, breaker thresholds). */
export const configureProviderResilience = (
  partial: Partial<ResilienceConfig>,
): void => {
  config = { ...config, ...partial };
};

type CircuitState = "closed" | "open" | "half-open";

type HealthRecord = {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  nextProbeAt: number | null;
  lastError: {
    status: number | null;
    type: string | null;
    message: string;
  } | null;
};

const health = new Map<string, HealthRecord>();

const recordFor = (provider: string): HealthRecord => {
  const existing = health.get(provider);
  if (existing) return existing;
  const fresh: HealthRecord = {
    consecutiveFailures: 0,
    lastError: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    nextProbeAt: null,
    state: "closed",
  };
  health.set(provider, fresh);

  return fresh;
};

const noteSuccess = (provider: string): void => {
  const record = recordFor(provider);
  record.state = "closed";
  record.consecutiveFailures = 0;
  record.nextProbeAt = null;
  record.lastError = null;
  record.lastSuccessAt = Date.now();
};

const noteFailure = (provider: string, error: ProviderError): void => {
  const record = recordFor(provider);
  record.consecutiveFailures += 1;
  record.lastFailureAt = Date.now();
  record.lastError = {
    message: error.message,
    status: error.status,
    type: error.type,
  };
  if (record.consecutiveFailures >= config.failureThreshold) {
    record.state = "open";
    record.nextProbeAt = Date.now() + config.openMs;
  }
};

export type ProviderHealth = {
  provider: string;
  /** True when the circuit is closed (provider believed healthy). */
  healthy: boolean;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  /** When the breaker will next allow a probe (epoch ms), if open. */
  nextRetryAt: number | null;
  lastError: {
    status: number | null;
    type: string | null;
    message: string;
  } | null;
  statusPageUrl: string | null;
};

const snapshot = (provider: string, record: HealthRecord): ProviderHealth => ({
  consecutiveFailures: record.consecutiveFailures,
  healthy: record.state === "closed",
  lastError: record.lastError,
  lastFailureAt: record.lastFailureAt,
  lastSuccessAt: record.lastSuccessAt,
  nextRetryAt: record.nextProbeAt,
  provider,
  state: record.state,
  statusPageUrl: providerStatusPage(provider),
});

/**
 * Inspect provider health as tracked by the circuit breaker. Pass a provider
 * name for one snapshot, or omit to get every provider seen this process.
 */
export function getProviderHealth(provider: string): ProviderHealth;
export function getProviderHealth(): ProviderHealth[];
export function getProviderHealth(
  provider?: string,
): ProviderHealth | ProviderHealth[] {
  if (provider !== undefined) return snapshot(provider, recordFor(provider));

  return [...health.entries()].map(([name, record]) => snapshot(name, record));
}

const backoffDelay = (attempt: number): number => {
  const exponential = config.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  // Full jitter: spread retries so concurrent callers don't reconnect in lockstep.
  return Math.round(capped / 2 + (Math.random() * capped) / 2);
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));

      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const circuitOpen = (provider: string): ProviderError | null => {
  const record = recordFor(provider);
  if (record.state !== "open") return null;
  if (record.nextProbeAt !== null && Date.now() >= record.nextProbeAt) {
    // Cooldown elapsed: allow a single probe through.
    record.state = "half-open";

    return null;
  }
  const detail = record.lastError?.message ?? "recent failures";

  return new ProviderError({
    message: `${provider} is temporarily unavailable (circuit open after ${record.consecutiveFailures} failures): ${detail}`,
    provider,
    retryable: true,
    status: record.lastError?.status ?? null,
    type: record.lastError?.type ?? null,
  });
};

/**
 * Wrap a provider with retry + circuit-breaker behaviour. The returned config
 * has the same `stream(params) => AsyncIterable<AIChunk>` shape.
 */
export const withResilience = (
  provider: AIProviderConfig,
  providerName = "unknown",
): AIProviderConfig => {
  const attempt = async function* (
    params: AIProviderStreamParams,
    attemptNo: number,
  ): AsyncIterable<AIChunk> {
    let yielded = false;
    try {
      for await (const chunk of provider.stream(params)) {
        yielded = true;
        yield chunk;
      }
      noteSuccess(providerName);
    } catch (err) {
      // Aborts are the caller's intent — propagate without touching health.
      const providerError = ProviderError.from(err, providerName);
      const canRetry =
        !yielded &&
        providerError.retryable &&
        attemptNo < config.maxRetries &&
        !params.signal?.aborted;

      if (canRetry) {
        await sleep(backoffDelay(attemptNo), params.signal);
        yield* attempt(params, attemptNo + 1);

        return;
      }

      noteFailure(providerName, providerError);
      throw providerError;
    }
  };

  return {
    stream: (params: AIProviderStreamParams) => {
      // Fail fast while the breaker is open — don't count this as a new failure
      // (no request was made); nextProbeAt already governs the cooldown.
      const tripped = circuitOpen(providerName);
      if (tripped) {
        return (async function* () {
          throw tripped;
        })();
      }

      return attempt(params, 0);
    },
  };
};
