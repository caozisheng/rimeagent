# Changelog

## 0.3.0 — 2026-10-11 (unreleased)

- Implemented the design's Phase 0–1 transport increment; runtime/session/tool execution semantics remain unchanged.
- Added four-category `normalizeError()` policy and optional normalized transport error metadata. Explicit permanent provider errors override retryable HTTP statuses.
- Added optional provider-reported USD cost and cache read/write token counts to `TokenUsage`.
- Added predicate backend registrations with newest-first routing, duplicate-identity diagnostics and idempotent disposal. Legacy custom registration remains last-wins.
- Replaced public `CloudLLMBackend` and `AnthropicLLMBackend` with `RimeAgentBackend`, without compatibility aliases. Direct/proxy protocol selection is preserved.
- Added optional `rimeagent/backends/vercel` with `ai >=5` peer dependency, host-injected model resolution, single-turn streaming, historical tool-turn conversion and cancellation on abort or early stream closure. No SDK retries or tool execution.
- Added transport/error regression coverage, source/test typechecking, CI tests and a core-only build that does not require `ai`.
- NativeLLMBackend is excluded. Durable runner contracts, storage, recovery, compaction and approvals remain later design phases.
