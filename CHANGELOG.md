# Changelog

## 0.8.0 — 2026-10-12 (unreleased)

- Added default annotation-based approval gates, durable pending requests and `resolveApproval()` with persisted allow/deny decisions and same-run/call resume after reload.
- Added strict JSON proposal previews stored as immutable artifacts; event payloads carry validated proposal digests and artifact references, not full diffs.
- Bound approvals to arguments, session/run, project identity/revision and preview digest, including revalidation before each dispatch when earlier batch edits change the project.
- Added opt-in adjacent read-only parallelism with all-settled handling and model-order results. Writes, role switches and undo/redo/restore remain serial barriers; default and legacy scheduling remain unchanged.
- Added host annotation contract checks and RimeCut registry migration guidance. NativeLLMBackend and Phase 7 contract publication remain excluded.
- Closed approval recovery crash windows: replay matching committed results despite the original approval revision; recognize denied session-result suffixes through their durable decisions; reconcile identical concurrent resolution ledger claims.
- Completed result replay takes precedence over changed approval policies; preflight replay-index failures preserve the original adapter exception instead of becoming normal run outcomes. Both paths have failing-before/passing-after regressions and compiled-runtime smoke coverage.
- Verified actual HTTP/SSE and Chromium IndexedDB approval → reload → resolve → same-run completion with one side effect, plus overlapping reads and ordered command/revision transitions through undo/redo/restore.

## 0.7.0 — 2026-10-12 (unreleased)

- Added `createContextManager()` and runtime context budgets over system prompts, complete conversation/tool turns and tool schemas, with an injectable tokenizer.
- Added immutable large-tool-result artifact projection. Models receive bounded success/message summaries plus artifact IDs; full results, call identities and replay caches remain intact.
- Added checkpoint-safe append-only compaction with eight-field host summaries, cumulative source IDs and restored prior summaries. Latest user requests and complete/pending tool batches stay protected; summaries never masquerade as current project facts.
- Runtime requests inject fresh host facts before dynamic context and rebuild RAG/error context on requests, role switches, tool failures and compaction. Durable checkpoint digests continue to cover full confirmed history.
- Added bounded context-overflow recovery: forced compaction, reduced output cap, then host skill/tool allowlists. Exhaustion persists an interrupted, resumable run rather than irreversible failure; provider/network/permission errors are not automatically retried.
- Added effective output caps to OpenAI direct/proxy, Anthropic and optional Vercel transport. Runtime budget overrides preserve config-specific backend selection and do not mutate host configuration.
- Added long-session, compaction, artifact, retry/cancellation, storage-fault and transport-budget regressions. Real HTTP/SSE + Chromium IndexedDB verified 55 tool turns, staged overflow and same-run reload recovery without repeating a committed edit.
- Closed reviewed safety gaps: reject project changes during model planning before rebinding confirmation; preserve model usage for rejected plans; enforce input limits over the final backend message/tool representation; propagate the original preparation storage exception even on the final recovery attempt.
- Preserved legacy loop/session event shapes and callback behavior. Approval suspend/resume, parallel tool strategies and NativeLLMBackend remain excluded from this increment.

## 0.6.0 — 2026-10-11 (unreleased)

- Implemented durable `resume(runId, signal?)` using the same run ID and a sequence beyond persisted events, checkpoints and ledger records; no duplicate user message or second agent loop.
- Persisted recovery cursors and confirmed boundaries; resume verifies session head, checkpoint digest and host project identity/revision before external execution. Partial model output restarts; pending tool batches continue; confirmed final responses settle without another provider call.
- Added serial `createToolExecutor()` with atomic global intent claims, immutable JSON result artifacts and completed success/failure replay. Non-idempotent uncertain effects block rather than retry; read-only/idempotent recovery records retries. Approval-sensitive execution remains refused.
- Added ledger intent/terminal records, global execution lookup, model usage and host command/revision linkage. Model accounting commits before confirmed assistant history; absent provider usage remains unknown, not fabricated zero consumption. Ledger does not store raw arguments/results or LLM credentials.
- Added optional `rimeagent/adapters/web` IndexedDB session/artifact/ledger stores. Transactions commit before resolution; races and aborts roll back IDs/indexes; open/blocked/quota/schema failures reject without volatile fallback.
- Added framework-neutral storage contract probes shared by memory and IndexedDB, host SQLite/file guidance, crash-window and reopened-store runtime coverage. Real Chromium reload/resume verified each of two edits executed once with the original run ID.
- Fresh runs reset their configured initial role/model; resume restores only its saved run state. Added failing-before/passing-after regressions for role leakage and final/role-switch model-accounting crash windows.
- Legacy session/callback behavior remains compatible. Compaction, approval suspend/resume and NativeLLMBackend are not implemented.

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
