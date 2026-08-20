import {
  OpenRouter as OfficialOpenRouterSDK,
  type SDKOptions,
} from "@openrouter/sdk";

export type OpenRouterSDKConfig = Omit<
  SDKOptions,
  "apiKey" | "appCategories" | "appTitle" | "httpReferer" | "serverURL"
> & {
  apiKey?: string;
  /** Comma-separated marketplace categories are produced from this list. */
  appCategories?: readonly string[];
  appName?: string;
  appUrl?: string;
  baseUrl?: string;
  tokenSource?: () => Promise<string> | string;
};

/**
 * Create OpenRouter's generated SDK with AbsoluteJS-style configuration.
 *
 * Use this for the complete REST surface: API keys, BYOK, guardrails,
 * observability, organizations, SCIM, datasets, benchmarks, and future
 * OpenAPI-generated additions. Use `openrouter()` for policy-aware inference.
 */
export const createOpenRouterSDK = (config: OpenRouterSDKConfig = {}) => {
  if (config.appCategories && config.appCategories.length > 2)
    throw new Error(
      "createOpenRouterSDK() appCategories supports at most 2 entries",
    );
  if (!config.apiKey && !config.tokenSource)
    throw new Error(
      "createOpenRouterSDK() requires either apiKey or tokenSource",
    );
  const {
    apiKey,
    appCategories,
    appName,
    appUrl,
    baseUrl,
    tokenSource,
    ...options
  } = config;
  return new OfficialOpenRouterSDK({
    ...options,
    apiKey: tokenSource ? async () => Promise.resolve(tokenSource()) : apiKey,
    appCategories: appCategories?.join(","),
    appTitle: appName,
    httpReferer: appUrl,
    serverURL: baseUrl,
  });
};

export { OfficialOpenRouterSDK as OpenRouterSDK };
export type { SDKOptions as OfficialOpenRouterSDKOptions } from "@openrouter/sdk";
export type { RequestOptions as OpenRouterSDKRequestOptions } from "@openrouter/sdk/lib/sdks.js";
