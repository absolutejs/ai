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

## SSE event stream (`streamAIToSSE`)

`streamAIToSSE` yields `{ event, data }` SSE frames. By default `data` is
pre-rendered HTML from the renderers, and the terminal `status` event is
overloaded across completion, budget stops, and errors — a headless consumer has
to sniff `ai-usage` vs `ai-error` out of the HTML to tell them apart.

Pass `structuredEvents: true` to get typed, machine-readable frames instead: each
`data` is JSON (parse it), and the overloaded terminal splits into three distinct
event names:

| event | when | `JSON.parse(data)` |
| --- | --- | --- |
| `content` | text delta | `{ delta, full }` |
| `thinking` | reasoning delta | `{ text }` (accumulated) |
| `tools` | one per tool transition | `{ name, status: "running" \| "complete", input, result? }` |
| `images` | generated image | `{ data, format, revisedPrompt? }` |
| `complete` | normal completion | `{ usage, durationMs, model }` |
| `stopped` | ceiling / limit / abort | `{ reason, detail }` |
| `error` | thrown / lookup error | `{ message }` |
| `ping` | heartbeat keepalive | `""` (unchanged) |

`stopped.reason` is one of `"max_total_tokens" | "max_duration_ms" | "max_tokens"
| "max_turns" | "aborted"`. Exactly one terminal (`complete` / `stopped` /
`error`) fires on every path — including an externally aborted loop, which now
emits `stopped` with `reason: "aborted"` rather than masquerading as a
completion. Payload types are exported (`AISSECompletePayload`,
`AISSEStoppedPayload`, `AISSEErrorPayload`, `AISSEContentPayload`, …).

The default (HTML) path is unchanged for the built-in HTMX/default UI, except an
abort now renders the (previously unused) `canceled` renderer instead of a
misleading usage chip.
