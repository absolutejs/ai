import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createOpenRouterClient,
  verifyOpenRouterWebhookSignature,
} from "../src/ai/providers/openrouterClient";

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

  test("filters user-aware and ZDR discovery through local policy", async () => {
    const client = createOpenRouterClient({
      allowedModels: ["anthropic/*"],
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/endpoints/zdr")) {
          return Response.json({
            data: [
              { model_id: "anthropic/claude", name: "Anthropic" },
              { model_id: "deepseek/v3", name: "DeepSeek" },
            ],
          });
        }
        return Response.json({
          data: [
            { id: "anthropic/claude" },
            { id: "deepseek/v3" },
          ],
        });
      }) as typeof fetch,
    });

    expect((await client.listUserModels()).data).toEqual([
      { id: "anthropic/claude" },
    ]);
    expect((await client.listZdrEndpoints()).data).toEqual([
      { model_id: "anthropic/claude", name: "Anthropic" },
    ]);
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

  test("streams dedicated image generation events", async () => {
    let body: Record<string, unknown> = {};
    const client = createOpenRouterClient({
      apiKey: "test-key",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          [
            "event: image_generation.partial_image",
            'data: {"type":"image_generation.partial_image","b64_json":"cGFydA==","partial_image_index":0}',
            "",
            "event: image_generation.completed",
            'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","usage":{"cost":0.04}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch,
    });

    const events = [];
    for await (const event of client.streamImage({
      model: "google/gemini-image",
      prompt: "A lighthouse",
    })) {
      events.push(event);
    }

    expect(body.stream).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "image_generation.partial_image",
      "image_generation.completed",
    ]);
    expect(events[1]?.usage).toEqual({ cost: 0.04 });
  });

  test("supports reusable files and video job workflows", async () => {
    const requests: Array<{
      body?: BodyInit | null;
      method?: string;
      url: string;
    }> = [];
    const client = createOpenRouterClient({
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ body: init?.body, method: init?.method, url: String(input) });
        if (String(input).endsWith("/content?index=1"))
          return new Response("video-bytes");
        return Response.json({
          created_at: "2026-08-20T00:00:00Z",
          downloadable: true,
          filename: "brief.pdf",
          id: String(input).includes("/videos") ? "video-1" : "file-1",
          mime_type: "application/pdf",
          size_bytes: 5,
          status: "pending",
          type: "file",
        });
      }) as typeof fetch,
    });

    await client.uploadFile(new Blob(["brief"]), {
      filename: "brief.pdf",
      workspaceId: "workspace-1",
    });
    await client.getFile("file-1", "workspace-1");
    await client.generateVideo({ model: "openai/sora", prompt: "Ocean" });
    await client.getVideo("video-1");
    expect(await (await client.downloadVideo("video-1", 1)).text()).toBe(
      "video-bytes",
    );

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/files?workspace_id=workspace-1",
      "https://openrouter.ai/api/v1/files/file-1?workspace_id=workspace-1",
      "https://openrouter.ai/api/v1/videos",
      "https://openrouter.ai/api/v1/videos/video-1",
      "https://openrouter.ai/api/v1/videos/video-1/content?index=1",
    ]);
    expect(requests[0]?.body).toBeInstanceOf(FormData);
    expect(requests[2]?.method).toBe("POST");
  });

  test("verifies video webhook signatures and rejects stale payloads", async () => {
    const body = '{"type":"video.generation.completed"}';
    const timestamp = 1_800_000_000;
    const signature = createHmac("sha256", "secret")
      .update(`${timestamp},${body}`)
      .digest("hex");
    const header = `t=${timestamp},v1=${signature}`;

    expect(
      await verifyOpenRouterWebhookSignature({
        body,
        header,
        nowSeconds: timestamp + 60,
        secret: "secret",
      }),
    ).toBe(true);
    expect(
      await verifyOpenRouterWebhookSignature({
        body,
        header,
        nowSeconds: timestamp + 301,
        secret: "secret",
      }),
    ).toBe(false);
    expect(
      await verifyOpenRouterWebhookSignature({
        body: `${body} `,
        header,
        nowSeconds: timestamp,
        secret: "secret",
      }),
    ).toBe(false);
  });
});
