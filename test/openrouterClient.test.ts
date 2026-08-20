import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createOpenRouterAuthorizationUrl,
  createOpenRouterClient,
  createOpenRouterKeyLinks,
  estimateOpenRouterModelCost,
  exchangeOpenRouterAuthCode,
  generateOpenRouterPKCE,
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

  test("uses the beta Batch API and waits for terminal results", async () => {
    const requests: Array<{ body?: string; url: string }> = [];
    let reads = 0;
    const client = createOpenRouterClient({
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ body: String(init?.body ?? ""), url: String(input) });
        if (init?.method === "POST")
          return Response.json({
            endpoint: "/v1/chat/completions",
            id: "batch-1",
            model: "anthropic/claude-sonnet-4.6",
            status: "validating",
          });
        reads += 1;
        return Response.json({
          endpoint: "/v1/chat/completions",
          id: "batch-1",
          model: "anthropic/claude-sonnet-4.6",
          results:
            reads === 2 ? [{ custom_id: "one", id: "result-1" }] : undefined,
          status: reads === 2 ? "completed" : "in_progress",
        });
      }) as typeof fetch,
    });

    await client.createBatch({
      endpoint: "/v1/chat/completions",
      model: "anthropic/claude-sonnet-4.6",
      requests: [{ body: { messages: [] }, custom_id: "one" }],
    });
    const completed = await client.waitForBatch("batch-1", { intervalMs: 0 });

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/beta/batches",
      "https://openrouter.ai/api/beta/batches/batch-1",
      "https://openrouter.ai/api/beta/batches/batch-1",
    ]);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      endpoint: "/v1/chat/completions",
      model: "anthropic/claude-sonnet-4.6",
      requests: [{ body: { messages: [] }, custom_id: "one" }],
    });
    expect(completed.status).toBe("completed");
    expect(completed.results?.[0]?.custom_id).toBe("one");
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
          data: [{ id: "anthropic/claude" }, { id: "deepseek/v3" }],
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
        requests.push({
          body: init?.body,
          method: init?.method,
          url: String(input),
        });
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

  test("supports typed preset creation and blocks nested disallowed models", async () => {
    const requests: Array<{ body?: string; url: string }> = [];
    const client = createOpenRouterClient({
      allowedModels: ["anthropic/*"],
      apiKey: "test-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ body: String(init?.body ?? ""), url: String(input) });
        return Response.json({ data: { slug: "support" } });
      }) as typeof fetch,
    });

    await client.createPresetFromChatCompletions("support/team", {
      messages: [{ content: "Hello", role: "user" }],
      model: "anthropic/claude-sonnet-4.6",
      plugins: [{ allowed_models: ["anthropic/*"], id: "auto-router" }],
    });
    await client.getPreset("support/team");
    await client.getPresetVersion("support/team", 2);

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/presets/support%2Fteam/chat/completions",
      "https://openrouter.ai/api/v1/presets/support%2Fteam",
      "https://openrouter.ai/api/v1/presets/support%2Fteam/versions/2",
    ]);
    expect(() =>
      client.createPresetFromResponses("unsafe", {
        input: "Hello",
        models: ["deepseek/deepseek-v3"],
      }),
    ).toThrow('OpenRouter model "deepseek/deepseek-v3" is not allowed');
  });

  test("supports transcription, analytics, and task classifications", async () => {
    const requests: Array<{ body?: string; method?: string; url: string }> = [];
    const client = createOpenRouterClient({
      apiKey: "management-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          body: String(init?.body ?? ""),
          method: init?.method,
          url: String(input),
        });
        return Response.json({
          data: { data: [], metadata: {} },
          text: "ok",
          usage: {},
        });
      }) as typeof fetch,
    });

    await client.transcribe({
      input_audio: { data: "UklGRg==", format: "wav" },
      language: "en",
      model: "openai/whisper-large-v3",
    });
    await client.getActivity({ date: "2026-08-19" });
    await client.getAnalyticsMeta();
    await client.queryAnalytics({
      dimensions: ["model"],
      metrics: ["request_count"],
      time_range: {
        end: "2026-08-20T00:00:00Z",
        start: "2026-08-19T00:00:00Z",
      },
    });
    await client.getTaskClassifications();

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/audio/transcriptions",
      "https://openrouter.ai/api/v1/activity?date=2026-08-19",
      "https://openrouter.ai/api/v1/analytics/meta",
      "https://openrouter.ai/api/v1/analytics/query",
      "https://openrouter.ai/api/v1/classifications/task?window=7d",
    ]);
    expect(requests[3]?.method).toBe("POST");
    expect(JSON.parse(requests[0]?.body ?? "{}").input_audio.format).toBe(
      "wav",
    );
  });

  test("supports workspace selection and management workflows", async () => {
    const requests: Array<{ body?: string; method?: string; url: string }> = [];
    const client = createOpenRouterClient({
      allowedModels: ["anthropic/*"],
      apiKey: "management-key",
      workspaceId: "workspace-default",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          body: String(init?.body ?? ""),
          method: init?.method,
          url: String(input),
        });
        return Response.json({ data: [], deleted: true });
      }) as typeof fetch,
    });

    await client.listFiles();
    await client.getActivity();
    await client.createWorkspace({
      default_text_model: "anthropic/claude-sonnet-4.6",
      name: "Production",
      slug: "production",
    });
    await client.updateWorkspace("production", {
      default_provider_sort: "price",
    });
    await client.listWorkspaces();
    await client.getWorkspace("production");
    await client.upsertWorkspaceBudget("production", "monthly", 100);
    await client.listWorkspaceBudgets("production");
    await client.deleteWorkspaceBudget("production", "monthly");
    await client.addWorkspaceMembers("production", ["user-1", "user-2"]);
    await client.removeWorkspaceMembers("production", ["user-2"]);
    await client.deleteWorkspace("production");

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/files?workspace_id=workspace-default",
      "https://openrouter.ai/api/v1/activity?workspace_id=workspace-default",
      "https://openrouter.ai/api/v1/workspaces",
      "https://openrouter.ai/api/v1/workspaces/production",
      "https://openrouter.ai/api/v1/workspaces?limit=100&offset=0",
      "https://openrouter.ai/api/v1/workspaces/production",
      "https://openrouter.ai/api/v1/workspaces/production/budgets/monthly",
      "https://openrouter.ai/api/v1/workspaces/production/budgets",
      "https://openrouter.ai/api/v1/workspaces/production/budgets/monthly",
      "https://openrouter.ai/api/v1/workspaces/production/members/add",
      "https://openrouter.ai/api/v1/workspaces/production/members/remove",
      "https://openrouter.ai/api/v1/workspaces/production",
    ]);
    expect(requests[2]?.method).toBe("POST");
    expect(requests[3]?.method).toBe("PATCH");
    expect(requests[6]?.method).toBe("PUT");
    expect(requests[11]?.method).toBe("DELETE");
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

describe("OpenRouter pricing", () => {
  test("estimates all documented per-unit price components", () => {
    const estimate = estimateOpenRouterModelCost(
      {
        pricing: {
          completion: "0.000002",
          input_cache_read: "0.0000001",
          prompt: "0.000001",
          request: "0.01",
          web_search: "0.004",
        },
      },
      {
        completion: 200,
        input_cache_read: 500,
        prompt: 1_000,
        request: 1,
        web_search: 2,
      },
    );
    expect(estimate.components.completion).toBeCloseTo(0.0004);
    expect(estimate.components.input_cache_read).toBeCloseTo(0.00005);
    expect(estimate.components.prompt).toBeCloseTo(0.001);
    expect(estimate.components.request).toBeCloseTo(0.01);
    expect(estimate.components.web_search).toBeCloseTo(0.008);
    expect(estimate.total).toBeCloseTo(0.01945);
  });

  test("rejects invalid quantities instead of underestimating cost", () => {
    expect(() =>
      estimateOpenRouterModelCost(
        { pricing: { prompt: "0.01" } },
        { prompt: -1 },
      ),
    ).toThrow("OpenRouter prompt units must be non-negative");
  });
});

describe("OpenRouter OAuth PKCE", () => {
  test("generates S256 PKCE and authorization URLs for web and headless apps", async () => {
    const pkce = await generateOpenRouterPKCE();
    expect(pkce.codeChallengeMethod).toBe("S256");
    expect(pkce.codeVerifier).toHaveLength(43);
    expect(pkce.codeChallenge).toHaveLength(43);
    expect(pkce.codeChallenge).not.toBe(pkce.codeVerifier);

    const webUrl = new URL(
      createOpenRouterAuthorizationUrl({
        callbackUrl: "https://app.example/callback",
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
      }),
    );
    expect(webUrl.origin + webUrl.pathname).toBe("https://openrouter.ai/auth");
    expect(webUrl.searchParams.get("callback_url")).toBe(
      "https://app.example/callback",
    );
    expect(webUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const headlessUrl = new URL(
      createOpenRouterAuthorizationUrl({
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: "S256",
        keyLabel: "Absolute CLI",
      }),
    );
    expect(headlessUrl.searchParams.has("callback_url")).toBe(false);
    expect(headlessUrl.searchParams.get("key_label")).toBe("Absolute CLI");
  });

  test("exchanges OAuth codes without leaking an unrelated API key", async () => {
    let request: { init?: RequestInit; url?: string } = {};
    const result = await exchangeOpenRouterAuthCode(
      {
        code: "authorization-code",
        code_challenge_method: "S256",
        code_verifier: "verifier",
      },
      {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          request = { init, url: String(input) };
          return Response.json({ key: "sk-or-user", user_id: "user-1" });
        }) as typeof fetch,
      },
    );

    expect(request.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(new Headers(request.init?.headers).has("authorization")).toBe(false);
    expect(result).toEqual({ key: "sk-or-user", user_id: "user-1" });
  });

  test("creates authenticated codes, generation-content requests, and key links", async () => {
    const requests: Array<{ body?: string; url: string }> = [];
    const client = createOpenRouterClient({
      apiKey: "management-key",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ body: String(init?.body ?? ""), url: String(input) });
        return Response.json({ data: { id: "code-or-generation" } });
      }) as typeof fetch,
    });
    await client.createAuthCode({
      callback_url: "https://app.example/callback",
      key_label: "Absolute",
      workspace_id: "workspace-1",
    });
    await client.getGenerationContent("generation/one");
    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/auth/keys/code",
      "https://openrouter.ai/api/v1/generation/content?id=generation%2Fone",
    ]);

    const links = await createOpenRouterKeyLinks("sk-or-user");
    expect(links.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(links.logsUrl).toBe(
      `https://openrouter.ai/logs?api_key_hash=${links.hash}`,
    );
    expect(links.settingsUrl).toBe(`https://openrouter.ai/keys/${links.hash}`);
  });
});
