type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit | BunFetchRequestInit,
) => Promise<Response>;

export type OAuth2ClientCredentialsConfig = {
  /** Token endpoint that issues client-credentials grants. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-joined scopes (or array). */
  scope?: string | string[];
  /** Optional audience parameter (Auth0, etc.). */
  audience?: string;
  /** Where to send credentials: request body (default) or HTTP Basic header. */
  authStyle?: "body" | "basic";
  /** Extra params merged into the token request body. */
  extraParams?: Record<string, string>;
  /** Refresh this many ms before the token actually expires. Defaults to 60s. */
  expirySkewMs?: number;
  /** Fallback lifetime when the response omits expires_in. Defaults to 3600s. */
  fallbackTtlSeconds?: number;
  fetch?: FetchLike;
  now?: () => number;
};

type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const readOAuth2ErrorDetail = async (response: Response): Promise<string> => {
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  return text.trim();
};

/**
 * Builds a `tokenSource` for `openai()` / `openaiCompatible()` that performs the
 * OAuth2 client-credentials flow against custom LLM gateways (Azure AD, Auth0,
 * enterprise proxies). Caches the access token in memory and refreshes it
 * automatically before expiry. Returns `() => Promise<string>`.
 */
export const createOAuth2ClientCredentialsTokenSource = (
  config: OAuth2ClientCredentialsConfig,
): (() => Promise<string>) => {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? (() => Date.now());
  const skewMs = config.expirySkewMs ?? 60_000;
  const fallbackTtl = config.fallbackTtlSeconds ?? 3_600;
  const scope = Array.isArray(config.scope)
    ? config.scope.join(" ")
    : config.scope;

  let cached: CachedToken | null = null;
  let inflight: Promise<string> | null = null;

  const requestToken = async (): Promise<string> => {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) body.set("scope", scope);
    if (config.audience) body.set("audience", config.audience);
    for (const [key, value] of Object.entries(config.extraParams ?? {})) {
      body.set(key, value);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (config.authStyle === "basic") {
      const encoded = btoa(`${config.clientId}:${config.clientSecret}`);
      headers.Authorization = `Basic ${encoded}`;
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    }

    const response = await fetchImpl(config.tokenUrl, {
      body,
      headers,
      method: "POST",
    });
    if (!response.ok) {
      const detail = await readOAuth2ErrorDetail(response);
      throw new Error(
        `OAuth2 client-credentials request failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const payload = (await response.json()) as TokenResponse;
    if (!payload.access_token) {
      throw new Error(
        "OAuth2 client-credentials response did not include access_token",
      );
    }
    const ttlSeconds = payload.expires_in ?? fallbackTtl;
    cached = {
      accessToken: payload.access_token,
      expiresAtMs: now() + ttlSeconds * 1_000,
    };
    return payload.access_token;
  };

  return async (): Promise<string> => {
    if (cached && cached.expiresAtMs - skewMs > now()) {
      return cached.accessToken;
    }
    if (inflight) return inflight;
    inflight = requestToken().finally(() => {
      inflight = null;
    });
    return inflight;
  };
};
