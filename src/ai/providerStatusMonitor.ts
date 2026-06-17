import {
  PROVIDER_STATUS_PAGES,
  providerStatusPage,
} from "./errors/providerError";
import { setProviderAvailability } from "./resilience";

// Proactive provider availability via Atlassian Statuspage JSON (free, public,
// CDN-cached, no auth). Meant to run SERVER-SIDE (one poll loop per instance) as
// the single source of truth — it primes the circuit breaker so a provider that
// the status page reports down fails fast WITHOUT first burning real user
// requests. Clients should read the server's view, not poll the status page.

// The specific status-page component that represents the API surface we call,
// per provider. Checking the component (not the overall page indicator) avoids
// false alarms — e.g. OpenAI's overall page can read "degraded" because of an
// unrelated surface while Chat Completions is fully operational.
const API_COMPONENT_BY_PROVIDER: Record<string, string> = {
  anthropic: "Claude API (api.anthropic.com)",
  openai: "Chat Completions",
};

// Statuspage component.status values that still mean "usable". Degraded = slower
// but working, so we don't disable on it; only genuine outages flip availability.
const AVAILABLE_COMPONENT_STATUSES = new Set([
  "operational",
  "degraded_performance",
]);

// Overall page indicators ("none" | "minor" | "major" | "critical"), used only
// as a fallback when the named component can't be found.
const AVAILABLE_PAGE_INDICATORS = new Set(["none", "minor"]);

export type ProviderApiStatus = {
  provider: string;
  /** Whether the API surface is usable (operational or merely degraded). */
  available: boolean;
  /** The raw component status or page indicator we read. */
  indicator: string;
  /** The status-page component matched, or null when we fell back to the page. */
  componentName: string | null;
  reason: string;
  statusPageUrl: string | null;
  checkedAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

const findComponentStatus = (
  body: unknown,
  componentName: string,
): string | null => {
  if (!isRecord(body) || !Array.isArray(body.components)) return null;
  const match = body.components
    .filter(isRecord)
    .find((component) => readString(component, "name") === componentName);

  return match ? readString(match, "status") : null;
};

const readPageIndicator = (body: unknown): string | null => {
  if (!isRecord(body) || !isRecord(body.status)) return null;
  const indicator = readString(body.status, "indicator");

  return indicator === "" ? null : indicator;
};

const fetchJson = async (
  url: string,
  signal?: AbortSignal,
): Promise<unknown> => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`status fetch ${response.status}`);

  return response.json();
};

const unknownStatus = (provider: string): ProviderApiStatus => ({
  available: true,
  checkedAt: Date.now(),
  componentName: null,
  indicator: "unknown",
  provider,
  reason: "",
  statusPageUrl: providerStatusPage(provider),
});

/**
 * Fetch the current API availability for a provider from its public status
 * page. Best-effort: any failure (no status page, network/CORS, parse error)
 * resolves to "available: true, unknown" so a flaky status page never blocks a
 * provider that might actually be fine.
 */
export const fetchProviderApiStatus = async (
  provider: string,
  signal?: AbortSignal,
): Promise<ProviderApiStatus> => {
  const base = PROVIDER_STATUS_PAGES[provider];
  if (base === undefined) return unknownStatus(provider);

  try {
    const componentName = API_COMPONENT_BY_PROVIDER[provider] ?? null;
    if (componentName !== null) {
      const components = await fetchJson(
        `${base}/api/v2/components.json`,
        signal,
      );
      const status = findComponentStatus(components, componentName);
      if (status !== null) {
        const available = AVAILABLE_COMPONENT_STATUSES.has(status);

        return {
          available,
          checkedAt: Date.now(),
          componentName,
          indicator: status,
          provider,
          reason: available ? "" : `${status} on ${componentName}`,
          statusPageUrl: base,
        };
      }
    }

    // Fallback: overall page indicator.
    const summary = await fetchJson(`${base}/api/v2/status.json`, signal);
    const indicator = readPageIndicator(summary);
    if (indicator === null) return unknownStatus(provider);
    const available = AVAILABLE_PAGE_INDICATORS.has(indicator);

    return {
      available,
      checkedAt: Date.now(),
      componentName: null,
      indicator,
      provider,
      reason: available ? "" : `page status: ${indicator}`,
      statusPageUrl: base,
    };
  } catch {
    return unknownStatus(provider);
  }
};

export type ProviderStatusMonitorOptions = {
  /** Providers to watch. Default: anthropic + openai. */
  providers?: string[];
  /** Poll interval. Default 60s (status pages are CDN-cached ~30s). */
  intervalMs?: number;
  /** Called with each provider's status after every poll. */
  onUpdate?: (status: ProviderApiStatus) => void;
};

/**
 * Start a server-side poll loop that feeds provider availability into the
 * circuit breaker (via setProviderAvailability). Returns a stop function.
 * Run ONE per process; clients should read the resulting getProviderHealth()
 * via your own endpoint rather than polling status pages themselves.
 */
export const startProviderStatusMonitor = (
  options?: ProviderStatusMonitorOptions,
) => {
  const providers = options?.providers ?? ["anthropic", "openai"];
  const intervalMs = options?.intervalMs ?? 60_000;

  const tick = async () => {
    const results = await Promise.all(
      providers.map((provider) => fetchProviderApiStatus(provider)),
    );
    for (const status of results) {
      setProviderAvailability(status.provider, {
        available: status.available,
        indicator: status.indicator,
        reason: status.reason,
      });
      options?.onUpdate?.(status);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  return () => clearInterval(timer);
};
