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
