import { describe, expect, test } from "bun:test";
import { createOAuth2ClientCredentialsTokenSource } from "../src/ai/providers/oauth2TokenSource";

type Captured = { url: string; body: string; headers: Record<string, string> };

const mockFetch = (
  responses: Array<{ access_token: string; expires_in?: number }>,
  captured: Captured[],
  ok = true,
): typeof fetch => {
  let call = 0;
  return Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        body: String(init?.body ?? ""),
        headers: (init?.headers ?? {}) as Record<string, string>,
        url: String(input),
      });
      const payload = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: ok ? 200 : 401 }),
      ) as ReturnType<typeof fetch>;
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
};

const baseConfig = {
  clientId: "id",
  clientSecret: "secret",
  tokenUrl: "https://auth.example.com/oauth/token",
};

describe("createOAuth2ClientCredentialsTokenSource", () => {
  test("fetches a token and sends client-credentials grant in the body", async () => {
    const captured: Captured[] = [];
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      fetch: mockFetch([{ access_token: "tok-1", expires_in: 3600 }], captured),
      scope: ["a", "b"],
    });
    const token = await source();
    expect(token).toBe("tok-1");
    expect(captured[0]?.url).toBe("https://auth.example.com/oauth/token");
    expect(captured[0]?.body).toContain("grant_type=client_credentials");
    expect(captured[0]?.body).toContain("client_id=id");
    expect(captured[0]?.body).toContain("scope=a+b");
  });

  test("caches the token until near expiry", async () => {
    const captured: Captured[] = [];
    let t = 1_000_000;
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      fetch: mockFetch(
        [
          { access_token: "tok-1", expires_in: 3600 },
          { access_token: "tok-2", expires_in: 3600 },
        ],
        captured,
      ),
      now: () => t,
    });
    expect(await source()).toBe("tok-1");
    t += 1_000; // still well within validity
    expect(await source()).toBe("tok-1");
    expect(captured).toHaveLength(1);
  });

  test("refreshes once the skew window is crossed", async () => {
    const captured: Captured[] = [];
    let t = 1_000_000;
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      expirySkewMs: 60_000,
      fetch: mockFetch(
        [
          { access_token: "tok-1", expires_in: 100 },
          { access_token: "tok-2", expires_in: 100 },
        ],
        captured,
      ),
      now: () => t,
    });
    expect(await source()).toBe("tok-1");
    t += 100_000; // past expiry
    expect(await source()).toBe("tok-2");
    expect(captured).toHaveLength(2);
  });

  test("basic auth style sends credentials in the Authorization header", async () => {
    const captured: Captured[] = [];
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      authStyle: "basic",
      fetch: mockFetch([{ access_token: "tok" }], captured),
    });
    await source();
    expect(captured[0]?.headers.Authorization).toBe(
      `Basic ${btoa("id:secret")}`,
    );
    expect(captured[0]?.body).not.toContain("client_secret");
  });

  test("audience + extraParams are included", async () => {
    const captured: Captured[] = [];
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      audience: "https://api.example.com",
      extraParams: { resource: "llm-gateway" },
      fetch: mockFetch([{ access_token: "tok" }], captured),
    });
    await source();
    expect(captured[0]?.body).toContain("audience=https");
    expect(captured[0]?.body).toContain("resource=llm-gateway");
  });

  test("dedupes concurrent requests into one fetch", async () => {
    const captured: Captured[] = [];
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      fetch: mockFetch([{ access_token: "tok", expires_in: 3600 }], captured),
    });
    const [a, b] = await Promise.all([source(), source()]);
    expect(a).toBe("tok");
    expect(b).toBe("tok");
    expect(captured).toHaveLength(1);
  });

  test("throws on a non-OK token response", async () => {
    const source = createOAuth2ClientCredentialsTokenSource({
      ...baseConfig,
      fetch: mockFetch([{ access_token: "" }], [], false),
    });
    await expect(source()).rejects.toThrow(/client-credentials request failed/);
  });
});
