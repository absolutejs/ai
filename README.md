# @absolutejs/ai

Standalone AI runtime and provider package extracted from AbsoluteJS.

This package currently focuses on generic AI/chat/provider functionality.
RAG remains a separate package.

Provider traffic can cross a trusted control plane without reimplementing a
vendor protocol. `remoteProvider()` carries normalized provider parameters and
chunks over SSE, while `createProviderProxyResponse()` hosts any
`AIProviderConfig` with pre-first-token and inter-token heartbeats. Provider
callbacks and abort objects never cross the wire. The Anthropic provider also
accepts an injectable `fetch`, allowing hosts to retain egress policy, tracing,
and test transports.

## Conversation turn queues and branches

`aiChat()` serializes turns per conversation. A member may submit follow-ups
while a response is streaming: the server emits `turn_queued`, then
`turn_started` when that turn becomes active. Every framework adapter sends a
stable client message ID, and its message state exposes `isQueued` for UI.

`branch(messageId, content)` creates a new conversation through the selected
message and immediately runs `content` as the first turn on that branch. The
typed `branched` event switches the client to the new conversation.

`edit(messageId, content)` creates a new conversation through the history before
the selected user message, replaces that message with `content`, and runs it
again. The original conversation remains unchanged, matching the edit behavior
of modern AI chat interfaces without rewriting conversation history.

Custom REST/SSE hosts can use the same ordering primitive:

```ts
import { createConversationTurnQueue } from "@absolutejs/ai/client";

const queue = createConversationTurnQueue({
  execute: async (turn, { signal }) => runTurn(turn, signal),
});

queue.enqueue({ content: "First" });
queue.enqueue({ content: "Send this after the first reply" });
```

Failures stop later turns from overtaking the failed message. The host must
explicitly retry or remove it. `subscribe()` exposes immutable queue snapshots
for framework-independent UI.

## SSE event stream (`streamAIToSSE`)

`streamAIToSSE` yields `{ event, data }` SSE frames. By default `data` is
pre-rendered HTML from the renderers, and the terminal `status` event is
overloaded across completion, budget stops, and errors — a headless consumer has
to sniff `ai-usage` vs `ai-error` out of the HTML to tell them apart.

Pass `structuredEvents: true` to get typed, machine-readable frames instead: each
`data` is JSON (parse it), and the overloaded terminal splits into three distinct
event names:

| event      | when                    | `JSON.parse(data)`                                          |
| ---------- | ----------------------- | ----------------------------------------------------------- |
| `content`  | text delta              | `{ delta, full }`                                           |
| `thinking` | reasoning delta         | `{ text }` (accumulated)                                    |
| `tools`    | one per tool transition | `{ name, status: "running" \| "complete", input, result? }` |
| `images`   | generated image         | `{ data, format, revisedPrompt? }`                          |
| `complete` | normal completion       | `{ usage, durationMs, model }`                              |
| `stopped`  | ceiling / limit / abort | `{ reason, detail }`                                        |
| `error`    | thrown / lookup error   | `{ message }`                                               |
| `ping`     | heartbeat keepalive     | `""` (unchanged)                                            |

`stopped.reason` is one of `"max_total_tokens" | "max_duration_ms" | "max_tokens"
| "max_turns" | "aborted"`. Exactly one terminal (`complete` / `stopped` /
`error`) fires on every path — including an externally aborted loop, which now
emits `stopped` with `reason: "aborted"` rather than masquerading as a
completion. Payload types are exported (`AISSECompletePayload`,
`AISSEStoppedPayload`, `AISSEErrorPayload`, `AISSEContentPayload`, …).

The default (HTML) path is unchanged for the built-in HTMX/default UI, except an
abort now renders the (previously unused) `canceled` renderer instead of a
misleading usage chip.

## OpenRouter

`@absolutejs/ai/openrouter` uses the shared provider contract and
OpenAI-compatible stream parser while adding OpenRouter-specific routing,
attribution, cost metadata, and local model-policy enforcement.

```ts
import { openrouter } from "@absolutejs/ai/openrouter";

const provider = openrouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  appName: "My AbsoluteJS App",
  appUrl: "https://example.com",
  // Exact IDs and namespace wildcards are supported. A disallowed model fails
  // locally before any request reaches OpenRouter.
  allowedModels: ["anthropic/*", "google/*", "mistralai/*", "openai/*"],
  // This becomes provider.only, so OpenRouter cannot select another inference
  // provider during fallback.
  allowedProviders: ["anthropic", "google-vertex", "mistral", "openai"],
  routing: {
    dataCollection: "deny",
    maxPrice: { prompt: 3, completion: 15 },
    requireParameters: true,
    sort: "price",
    zdr: true,
  },
});
```

The adapter intentionally has no built-in geopolitical model list. Omitting
`allowedModels` exposes the full OpenRouter catalog; applications that need a
restricted catalog can define their own `allowedModels` and `allowedProviders`
policy. Avoid `openrouter/auto` under a strict policy unless it is deliberately
allowed.

Provider usage callbacks include OpenRouter's reported `costCredits`,
`upstreamInferenceCostCredits`, cache-read/write token counts, and reasoning
tokens when those fields are present in the final streaming usage message.
Hosted-tool counters are exposed as `serverToolUse`.

OpenRouter-specific features are available per request without weakening the
portable provider contract:

```ts
await generateAI({
  provider,
  model: "anthropic/claude-sonnet-4.6",
  messages,
  providerOptions: {
    openrouter: {
      fallbackModels: ["openai/gpt-5.2"],
      sessionId: conversationId, // sticky routing improves prompt-cache hits
      serviceTier: "flex", // cheaper, slower capacity when available
      responseCache: { enabled: true, ttlSeconds: 300 },
      serverTools: [
        { type: "openrouter:web_search", parameters: { max_results: 3 } },
      ],
      maxToolCalls: 5,
      stopServerToolsWhen: [{ type: "max_cost", value: 0.02 }],
    },
  },
});
```

Other typed request options include presets, plugins, per-call provider routing,
message transforms, native reasoning controls, prompt and response caching,
text-plus-audio output, verbosity, user attribution, and an `extraBody` escape
hatch for new OpenRouter parameters. The escape hatch cannot replace models,
fallbacks, providers, presets, messages, plugins, or tools; those fields use
policy-aware typed options instead.

URL images and PDFs, base64 audio, and URL/base64 video inputs use the ordinary
AbsoluteJS content-block contract. URL citations are emitted as `citation`
chunks. The final `done` chunk includes the generation ID, resolved model,
selected inference provider, service tier, cache headers, and OpenRouter router
metadata when reported.

### OpenRouter platform client

`createOpenRouterClient()` covers model/provider discovery, embeddings,
reranking, streamed and non-streamed image generation, reusable files,
Responses, speech, transcription, video jobs and downloads, batches, presets,
credits, key metadata, and generation metadata. It also exports
`verifyOpenRouterWebhookSignature()` for video completion webhooks. Its typed
operations enforce the same model allowlist. `request()` and `requestRaw()` are
forward-compatible access to new or administrative OpenRouter endpoints.

```ts
import { createOpenRouterClient } from "@absolutejs/ai/openrouter";

const openrouterClient = createOpenRouterClient({
  apiKey: process.env.OPENROUTER_API_KEY,
  allowedModels: ["anthropic/*", "google/*", "mistralai/*", "openai/*"],
});

const models = await openrouterClient.listModels({
  output_modalities: "all",
  sort: "pricing-low-to-high",
});
const embedding = await openrouterClient.createEmbedding({
  model: "openai/text-embedding-3-small",
  input: "AbsoluteJS supports OpenRouter",
});
const reranked = await openrouterClient.rerank({
  model: "openai/text-embedding-3-small",
  query: "cost controls",
  documents: ["response caching", "CSS layout"],
});
```

For a strict model-origin policy, also assign an OpenRouter key/workspace
guardrail with the same model allowlist. Provider allowlists restrict where a
model runs; they do not identify who developed it. Presets and router aliases
must be explicitly allowed, because their resolved model is controlled outside
the request. The raw client is intentionally unopinionated and should be limited
to trusted server-side administration code. OpenRouter's official SDK can be
used alongside this package for its complete organization, SSO, SCIM, BYOK, and
analytics type surface.

Use `openrouterResponses(config)` when an AbsoluteJS agent should stream through
OpenRouter's stateless Responses API, or `openrouterMessages(config)` for the
native Anthropic Messages protocol. Both accept the same model/provider policies
and `providerOptions.openrouter` controls, including replayable hosted-tool data.
