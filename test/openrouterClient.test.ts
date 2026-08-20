import { describe, expect, test } from "bun:test";
import { createOpenRouterClient } from "../src/ai/providers/openrouterClient";

describe("createOpenRouterClient", () => {
  test("filters discovery and authenticates typed requests", async () => {
    const requests: Array<{ body?: string; url: string }> = [];
    const client = createOpenRouterClient({
      allowedModels: ["anthropic/*", "openai/*"],
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ body: String(init?.body ?? ""), url: String(input) });
        if (String(input).endsWith("/models")) {
          return Response.json({
            data: [
              { id: "anthropic/claude-sonnet-4.6" },
              { id: "deepseek/deepseek-v3" },
            ],
          });
        }
        return Response.json({
          data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
          model: "openai/text-embedding-3-small",
          object: "list",
        });
      }) as typeof fetch,
    });

    expect((await client.listModels()).data).toEqual([
      { id: "anthropic/claude-sonnet-4.6" },
    ]);
    await client.createEmbedding({
      input: "hello",
      model: "openai/text-embedding-3-small",
    });
    expect(requests[1]?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
      input: "hello",
      model: "openai/text-embedding-3-small",
    });
  });

  test("blocks disallowed models before endpoint requests", () => {
    let fetches = 0;
    const client = createOpenRouterClient({
      allowedModels: ["anthropic/*"],
      apiKey: "test-key",
      fetch: (async () => {
        fetches += 1;
        return Response.json({});
      }) as typeof fetch,
    });

    expect(() =>
      client.generateImage({
        model: "bytedance-seed/seedream-4.5",
        prompt: "hello",
      }),
    ).toThrow('OpenRouter model "bytedance-seed/seedream-4.5" is not allowed');
    expect(fetches).toBe(0);
  });

  test("keeps a raw forward-compatible API escape hatch", async () => {
    let requestUrl = "";
    const client = createOpenRouterClient({
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL) => {
        requestUrl = String(input);
        return Response.json({ data: { ok: true } });
      }) as typeof fetch,
    });
    const result = await client.request<{ data: { ok: boolean } }>(
      "/guardrails",
      { query: { workspace_id: "workspace-1" } },
    );
    expect(requestUrl).toBe(
      "https://openrouter.ai/api/v1/guardrails?workspace_id=workspace-1",
    );
    expect(result.data.ok).toBe(true);
  });
});
