# Changelog

## 0.5.0 — 2026-10-11 (unreleased)

- Added `createAgentRuntime()` with run/checkpoint/abort and observable idle/running/interrupted/settled lifecycle state.
- Migrated iteration, serial tool execution, role switching and failure-context joins into one runtime-owned iteration kernel. `runAgentSession()` now delegates through a compatible in-memory bridge; legacy event shapes and callback exception behavior remain unchanged.
- Runtime runs append confirmed messages and lifecycle entries, save iteration checkpoints, and expose versioned events with per-run monotonic sequences. Completion explicitly reports response/max_iterations and iteration count.
- Caller abort and early generator closure cancel the provider; already-started host tools finish and record their result before interruption. No subsequent tools or model requests start after cancellation.
- Checkpoint labels are optional persisted metadata. Storage failures propagate instead of producing fabricated durable success events.
- New runtime calls refuse approval-sensitive tools before side effects until the approval gate is implemented. The legacy callback path is unchanged.
- Added lifecycle, cancellation, role/failure and session-parity coverage. Durable restart/resume, ledger replay enforcement, compaction and approval suspend/resume remain later phases; no placeholder methods are exported. NativeLLMBackend is excluded.

## 0.4.0 — 2026-10-11 (unreleased)

- Implemented Phase 2 runner contracts without changing the existing agent loop/session behavior.
- Added typed v2 runtime event envelopes, strict known-event parsing and safe skipping of unknown v2 event types. Opaque provider error causes are excluded from serialized events.
- Added all 16 session entry kinds, strict guards and persistence serialization. Entry serialization removes opaque error causes; persisted causes are rejected.
- Added isolated append-only in-memory session/checkpoint and JSON artifact stores. Duplicate IDs, invalid checkpoint boundaries and cross-session ancestry reject atomically.
- Added model-visible canonical UTF-8 FNV-1a32 context digests and checkpoint/branch reference types; no project rollback operations.
- Added an in-memory ledger with per-run increasing sequence boundaries, digest/revision command linkage and success-only tool replay queries.
- Added optional tool annotations without changing model-facing tool definitions, and froze host-produced project-facts/context types.
- Added regression coverage for serialization, isolation, sequence/identity boundaries, unsupported JSON and accessor/prototype validation.
- Recorded clean-room implementation provenance and the release audit checklist. Host-owner sign-off remains pending.
- `createAgentRuntime`, durable adapters, resume, compaction and approval execution remain later phases; NativeLLMBackend is excluded.

## 0.3.0 — 2026-10-11 (unreleased)

- Implemented the design's Phase 0–1 transport increment; runtime/session/tool execution semantics remain unchanged.
- Added four-category `normalizeError()` policy and optional normalized transport error metadata. Explicit permanent provider errors override retryable HTTP statuses.
- Added optional provider-reported USD cost and cache read/write token counts to `TokenUsage`.
- Added predicate backend registrations with newest-first routing, duplicate-identity diagnostics and idempotent disposal. Legacy custom registration remains last-wins.
- Replaced public `CloudLLMBackend` and `AnthropicLLMBackend` with `RimeAgentBackend`, without compatibility aliases. Direct/proxy protocol selection is preserved.
- Added optional `rimeagent/backends/vercel` with `ai >=5` peer dependency, host-injected model resolution, single-turn streaming, historical tool-turn conversion and cancellation on abort or early stream closure. No SDK retries or tool execution.
- Added transport/error regression coverage, source/test typechecking, CI tests and a core-only build that does not require `ai`.
- NativeLLMBackend is excluded. Durable runner contracts, storage, recovery, compaction and approvals remain later design phases.
