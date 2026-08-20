import { describe, expect, test } from "bun:test";
import {
  createOpenRouterSDK,
  OpenRouterSDK,
} from "../src/ai/providers/openrouterSDK";

describe("createOpenRouterSDK", () => {
  test("maps AbsoluteJS configuration onto the generated official SDK", () => {
    const sdk = createOpenRouterSDK({
      apiKey: "management-key",
      appCategories: ["cloud-agent", "productivity"],
      appName: "AbsoluteJS",
      appUrl: "https://absolutejs.com",
      baseUrl: "https://eu.openrouter.ai/api/v1",
      timeoutMs: 15_000,
    });

    expect(sdk).toBeInstanceOf(OpenRouterSDK);
    expect(sdk._baseURL?.toString()).toBe("https://eu.openrouter.ai/api/v1/");
    expect(sdk._options.appCategories).toBe("cloud-agent,productivity");
    expect(sdk._options.appTitle).toBe("AbsoluteJS");
    expect(sdk._options.httpReferer).toBe("https://absolutejs.com");
    expect(sdk._options.timeoutMs).toBe(15_000);
  });

  test("exposes the complete generated service surface", () => {
    const sdk = createOpenRouterSDK({ apiKey: "management-key" });

    expect(sdk.apiKeys).toBeDefined();
    expect(sdk.benchmarks).toBeDefined();
    expect(sdk.byok).toBeDefined();
    expect(sdk.datasets).toBeDefined();
    expect(sdk.guardrails).toBeDefined();
    expect(sdk.observability).toBeDefined();
    expect(sdk.organization).toBeDefined();
    expect(sdk.scim).toBeDefined();
  });

  test("accepts rotating credentials and validates attribution", () => {
    expect(() =>
      createOpenRouterSDK({
        appCategories: ["one", "two", "three"],
        tokenSource: () => "rotated-key",
      }),
    ).toThrow("createOpenRouterSDK() appCategories supports at most 2 entries");
    expect(() => createOpenRouterSDK()).toThrow(
      "createOpenRouterSDK() requires either apiKey or tokenSource",
    );
  });
});
