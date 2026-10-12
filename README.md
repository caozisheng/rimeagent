# rimeagent

Host-agnostic LLM agent engine with tool registry, streaming, and expert role orchestration.

## Features

- **Multi-provider LLM streaming** — OpenAI-compatible and Anthropic native, with pluggable backends
- **Tool calling** — Registry-based tool system with typed definitions and execution
- **Expert roles** — Orchestrator mode with dynamic role switching
- **Skills** — Skill registry with prompt layers and tool refs
- **MCP support** — Model Context Protocol tool provider integration
- **Session management** — Multi-iteration agent loop with tool execution and failure recovery
- **Durable runtime** — Injected session/artifact/ledger stores, validated resume and an optional IndexedDB adapter

## Install

```bash
npm install rimeagent
# or
bun add rimeagent
```

## Usage

```typescript
import {
  ToolRegistry,
  SkillRegistry,
  ExpertRoleRegistry,
  runAgentSession,
} from "rimeagent";

// Register tools
ToolRegistry.register(myTool);

// Run an agent session
const events = runAgentSession(
  {
    messages,
    llmConfig: { baseUrl, apiKey, model },
    expertRoleId: "general",
    tools: ToolRegistry.getDefinitions(),
  },
  {
    maxIterations: 5,
    onToolCall: async (tc) => {
      const tool = ToolRegistry.get(tc.function.name);
      return tool.execute(JSON.parse(tc.function.arguments));
    },
  },
);

for await (const event of events) {
  // handle streaming events
}
```

## Transport backends (0.3.0)

The default `RimeAgentBackend` selects OpenAI-compatible transport or native
Anthropic transport for `api.anthropic.com`. Third-party Claude proxies remain
OpenAI-compatible. `runAgentLoop` and `runAgentSession` retain their existing
contracts; durable run execution, recovery and approvals are not implemented yet.

Vercel AI SDK is an optional peer, imported only through `rimeagent/backends/vercel`.
The host supplies a model resolver and owns provider packages, credentials and
proxy configuration. Example for an explicitly selected direct OpenAI backend:

```bash
npm install ai @ai-sdk/openai
```

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { registerLLMBackendFor } from "rimeagent";
import { VercelAIBackend } from "rimeagent/backends/vercel";

const unregister = registerLLMBackendFor(
  (config) => config.provider === "openai" && config.directMode === true,
  new VercelAIBackend((config) => createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  }).chat(config.model)),
);

// Call unregister() when the host removes this backend.
```

Predicates are checked newest-first, then the legacy `registerLLMBackend()` slot,
then the built-in baseline. Registering the same predicate function twice throws;
the new registration's disposer is idempotent. Legacy registration still uses
last-registration-wins semantics. The Vercel adapter performs one model turn,
without SDK retries or tool execution; caller abort and early generator closure
cancel the provider request. System prompt layers use the SDK system channel.

`normalizeError()` exports four policy categories: `provider`, `context_overflow`,
`tool_failure`, `interrupted`. Transport error chunks retain `message` and add
optional `error` metadata; legacy `AgentEvent` shapes are unchanged. Permanent
quota/authentication errors are not retryable, even with a retryable HTTP status.
`TokenUsage` adds optional `cost` (provider-reported USD), `cacheReadTokens` and
`cacheWriteTokens`; absent data is not estimated. Vercel reads SDK cache details
and provider metadata `cost`, `cacheWriteTokens` or `cacheCreationInputTokens`.
JSON schemas describe tools to the model; domain argument validation remains
with the host's tool execution layer.

Migration: direct imports of `CloudLLMBackend` or `AnthropicLLMBackend` must use
`RimeAgentBackend`; the old class names are removed, not aliased. No native
backend or Tauri dependency is included.

## Runner contracts (0.4.0)

The main entry exports functional in-memory session, artifact and ledger stores,
checkpoint/digest helpers, and versioned event/entry serialization contracts.
The stores and serialization helpers remain available independently. Runtime
0.6.0 uses session history, checkpoints, an execution ledger and cached artifacts
for recovery. The legacy session wrapper keeps an isolated in-memory runtime
and its original event and callback API.

```typescript
import {
  InMemorySessionStore,
  createAgentRuntimeEvent,
  parseAgentRuntimeEvent,
} from "rimeagent";

const store = new InMemorySessionStore();
await store.append("session", {
  kind: "user_message", id: "entry-1", ts: 0, content: "Edit this clip",
});

const event = createAgentRuntimeEvent("run", 1, 0, {
  kind: "run_started", sessionId: "session",
});
const decoded = parseAgentRuntimeEvent(JSON.parse(JSON.stringify(event)));
if (decoded?.type === "run_started") {
  console.log(decoded.payload.sessionId);
}
```

- `InMemorySessionStore`: `load`, `append`, `saveCheckpoint`, `listCheckpoints`.
  Entry IDs are unique per session; returned snapshots and input records are
  isolated. Checkpoint IDs are globally unique and immutable; boundaries cannot
  exceed appended history. Parents must exist in the same session at an earlier
  or equal boundary. A root checkpoint at boundary 0 can create an empty session.
- `InMemoryArtifactStore`: `put({ artifactId, sessionId, contentType, value })`,
  `get(artifactId)`, `list(sessionId)`. Values are strict JSON data, not media
  bytes. Global artifact IDs cannot be overwritten.
- `InMemoryLedger`: `append`, `query(runId)`, `hasExecuted(toolCallId)` and
  `getToolExecution(toolCallId)`. Positive safe-integer sequences strictly increase
  per run (gaps allowed). Global tool intent claims reject duplicate writers;
  replay lookup prefers a successful execution, otherwise the latest intent/result.
- `serializeAgentSessionEntry` / `parseAgentSessionEntry` validate all 18 kinds
  and nested typed fields. Serializing live errors removes opaque `cause`;
  parsing persisted causes or unknown kinds/fields rejects. Host code must still
  keep secrets out of prompt/result text and arbitrary tool data.
- `createAgentRuntimeEvent(runId, seq, ts, payload)` takes an explicit clock and
  sequence. `parseAgentRuntimeEvent` returns `null` for unknown v2 types, throws
  for unsupported versions or damaged known events, and supports outer `type`
  narrowing. Event error causes are sanitized too.
- `computeContextDigest(messages)` hashes canonical model-visible fields with
  UTF-8 FNV-1a32; UI IDs/timestamps/results are ignored. It is not a cryptographic
  integrity mechanism, and branching never restores a host project.
- `AgentTool.annotations` carries read-only/destructive/idempotent/approval and
  serial/parallel metadata without entering the LLM schema. Scheduling defaults to
  serial; explicit approval-sensitive annotations suspend the durable runtime.

The memory stores are volatile: reuse the same three instances for in-process
resume, or inject durable stores for reload/process recovery. Runtime 0.8.0 builds
token-budgeted projections and host-produced compaction summaries without changing
the append-only log. Shared host storage probes live in
`tests/contract/store-contract.ts`; the published `./contract` subpath remains a later phase.

## Agent runtime (0.8.0)

```typescript
import { createAgentRuntime, InMemorySessionStore } from "rimeagent";

const runtime = createAgentRuntime({
  sessionId: "editing-session",
  sessionStore: new InMemorySessionStore(),
  llmConfig: { baseUrl, apiKey, model },
  expertRoleId: "general",
  tools: myTools,
  maxIterations: 10,
  hooks: {
    buildDynamicContext: () => currentTimelineSummary(),
  },
});

for await (const event of runtime.run("Trim the first clip")) {
  if (event.type === "text_delta") console.log(event.payload.content);
  if (event.type === "run_completed") {
    console.log(event.payload.reason, event.payload.iterations);
  }
}

const checkpoint = await runtime.checkpoint("after trim");
```

Each run has an independent ID. Events, checkpoints and ledger records share
an increasing per-run sequence, so event sequences can have gaps. Resume retains
the original runId and continues beyond every persisted sequence. The same runtime
instance rejects overlapping runs. `state` exposes idle/running/interrupted/settled;
`abort(reason?)`, a caller AbortSignal, or closing the generator interrupts the
run. An already-started host tool cannot be forcibly stopped: the runtime waits
for its result, records it, then stops without starting the next tool or request.
Providers must honor the supplied AbortSignal, and host tools must eventually
settle. Keep consuming or close the generator to let lifecycle cleanup finish.

Confirmed history and run terminal entries are written to the injected store;
each completed iteration receives a checkpoint. Write failures reject the
caller. `run_completed` reports `reason: "response" | "max_iterations"` and
`iterations`, including zero when no iterations are requested. `checkpoint(label?)`
records optional label metadata without altering the context digest.

`initialMessages` can seed an empty session; tool messages must contain serialized
`AgentToolResult` JSON plus a toolCallId. Existing history wins on later runs.
Prompt, locale, initial active role and role-switch tool definition are supported.
Hooks provide dynamic/RAG/error-recovery context and optional model changes on
role switching. `runAgentLoop()` remains the unchanged single-turn API.

An unfinished run must be continued with `resume(runId, signal?)`, not another
`run()`. Invalid, stale, completed or failed runs reject without durable writes or
model/tool calls. Resume verifies the checkpoint projection and, when bound, host
project identity/revision. Completed ledger revisions can account for a tool
committed immediately after the last checkpoint; unrelated host changes reject.
Partial model text is not confirmed history and is requested again. A confirmed
pending batch retains its original tool call IDs; a confirmed final response
settles without another provider request. Credentials and full model config are
not persisted; `onRoleSwitch` resolves the restored role's model configuration.
Fresh runs reset the configured initial role/model; only resume restores that
run's saved role override.
New runtime tools marked `destructive` or `requiresApproval` suspend before any
call in that model batch executes. Legacy `requiresConfirmation` remains refused;
migrate durable tools to annotations. The existing session callback policy is untouched.

### Durable approval and proposals

The default `createDefaultApprovalGate()` allows ordinary/read-only tools and
suspends explicitly destructive/approval-required calls. Handle
`run_awaiting_approval`, persist its `runId`, and display the pending call. Reopen
the same session/artifact/ledger stores after reload, then:

```typescript
await runtime.resolveApproval(toolCallId, "allow", "Reviewed by user"); // or "deny"
for await (const event of runtime.resume(runId)) handleEvent(event);
```

Resolution is persisted before the optional gate notification. Repeated identical
decisions are idempotent; conflicting, foreign, terminal or already-consumed calls
reject. Denial creates a durable failed tool result without invoking the tool.
Resume keeps the same run/call IDs and executes through ledger replay protection.
Approval binds arguments, run/session, project identity/revision and proposal.
Bindings are rechecked before dispatch: even an earlier edit in the same batch
can invalidate a later approval. A stale plan fails rather than editing a changed project.
Matching committed results replay without another policy decision or host effect,
even if the original approval revision or current gate policy has changed.

For custom host previews, supply `approval.preflight(context)` returning
`{ action: "suspend", reason, proposal, proposalDigest: computeProposalDigest(proposal) }`.
The proposal must be strict JSON. Its canonical digest is verified before storage;
`proposal` events carry only `toolCallId`, `proposalDigest` and `artifactId`.
Read the immutable preview with `artifactStore.get(artifactId)`; no preview means
no proposal event. Digests use FNV-1a32, not cryptographic authentication.

### Scheduling and host tool annotations

Set `executor: { parallelReadOnly: true }` to overlap adjacent calls whose tools
explicitly declare `readOnly: true, executionMode: "parallel"`. Results stay in
model order even when reads finish out of order. Every write, role switch and
`undo`/`redo`/`restore` is a serial barrier. Started reads all settle before the
next write; cancellation starts no later batch. Default scheduling remains serial.

RimeCut's tool registry migration belongs to the host repository. Annotate every
registered domain tool with explicit `readOnly`, `destructive`, `idempotent`,
`requiresApproval`, and `executionMode`; use the classification table in
[design §5.5](docs/rimeagent-design.md#55-tool-annotations-与执行策略对-g5-部分).
Run `assertToolAnnotationContract(tools)` from
`tests/contract/tool-annotation-contract.ts` against the assembled registry. It
rejects missing policies, duplicate names, parallel writes and contradictory
destructive reads without executing tools. The npm `./contract` export is Phase 7,
not part of this version; pin/copy the repository helper until that cutover.

## Durable Web stores and recovery

```typescript
import { createAgentRuntime } from "rimeagent";
import { createIndexedDBStores } from "rimeagent/adapters/web";

const stores = await createIndexedDBStores({ name: "editor-agent" });
const runtime = createAgentRuntime({
  sessionId, sessionStore: stores.sessionStore,
  artifactStore: stores.artifactStore, ledger: stores.ledger,
  llmConfig, expertRoleId: "general", tools: myTools,
  hooks: {
    getProjectFacts: () => ({
      producedBy: "host", projectId: currentProjectId(),
      projectRevision: currentProjectRevision(), digest: currentProjectDigest(),
    }),
  },
});

// Persist the runId received from run_started in the host's session UI state.
for await (const event of runtime.resume(savedRunId)) handleEvent(event);
stores.close();
```

Reopen the same database and session after reload and inject **all three stores**.
Missing IndexedDB, blocked opens, schema errors, transaction aborts and quota
failures reject; there is no automatic in-memory fallback. Writes resolve only
after transaction commit. The root import does not load the IndexedDB adapter or
AI SDK. The runtime uses `Array.findLast`; the Web adapter also requires
`Promise.withResolvers` on its platform.
Model-call accounting commits before confirmed assistant history, so a restart
after confirmation cannot discard reported usage. Missing provider usage remains
unknown rather than being reported as zero consumption.

`createToolExecutor({sessionId, tools, ledger, artifactStore, approval?, executor?})`
is available for hosts needing the same durable execution policy. Its `preflight`,
`execute`, and `executeBatch` share `{runId, nextSeq, signal?, projectFacts?, approvalDecisions?}`;
`nextSeq` must be shared with the host's run ledger. Low-level suspension rejects
before effects; the runtime owns durable suspension/resolution. Supply only
runtime-validated durable `approvalDecisions`, never unchecked UI decisions.
Catch `ApprovalRequiredError` to inspect its `toolCall` and suspend `decision`.
Optional context `onPersistenceFailure` marks preflight adapter faults; the original
adapter exception still rejects, distinct from policy allow/deny/suspend outcomes.
Execution commits an intent before calling the host, then an immutable result
artifact, then a `tool_exec` record, then the runtime's session result. Completed
successes **and failures** replay their cached result without invoking the tool.
Ledger records contain digests, not raw arguments/results. Optional
`data.commandId`, `data.projectRevisionBefore` and `data.projectRevisionAfter`
link the result to the host command log.

An intent without a completed execution means the external effect is uncertain.
Non-idempotent calls fail explicitly rather than execute again. Read-only or
host-proven idempotent calls can retry and record that retry. A losing concurrent
intent writer rejects. These rules prevent blind duplicate edits; they are not
an exactly-once guarantee across a process crash between a host side effect and
its durable result. The host must implement commandId idempotency/atomic commit
for that window. Do not label a mutating tool idempotent without that guarantee.

SQLite/file adapter requirements and the shared contract runner are documented
in [design appendix E](docs/rimeagent-design.md#附录-e宿主-sqlitefile-适配与共用契约验证).

## Context budgets, compaction and overflow recovery

New runtime requests use `ContextManager` by default. Configure `context` to
override token counting, window size, output reserve, compaction threshold and
large-result limits:

```typescript
const runtime = createAgentRuntime({
  sessionId, ...stores, llmConfig, expertRoleId: "general", tools: myTools,
  context: {
    contextTokens: 32768,
    reserveOutputTokens: 4096,
    compactTriggerRatio: 0.80,
    maxToolResultTokens: 2048,
    tokenizer: countTokens, // optional; default ceil(text.length / 4)
  },
  hooks: {
    getProjectFacts: () => currentHostProjectFacts(),
    summarizeContext: async ({ previousSummary, messages, projectFacts, signal }) => {
      // Host implementation: preserve intent and references from messages and
      // previousSummary. Return ContextSummary with every field below.
      return await summarizeConversation({ previousSummary, messages, projectFacts, signal });
    },
    filterTools: (_tools, { activeRoleId }) => activeSkillToolRefs(activeRoleId),
    buildRagContext: () => currentRetrievalContext(),
  },
});
```

`ContextSummary` requires `goal` (nonempty string) and string arrays
`constraints`, `completedEdits`, `decisions`, `failedTools`, `openQuestions`,
`nextSteps`, `references`. The summarizer belongs to the host; no built-in fake
summary or hidden model call exists. Missing summarizer/current host facts/safe
checkpoint means no compaction and no silent history deletion. Invalid summaries
reject before compaction append. Signals must be honored by host async hooks.

The default window is `llmConfig.contextLength ?? 32768`; the default output
reserve is `min(4096, floor(window / 2))`. A request's effective output cap is
`llmConfig.maxOutputTokens ?? reserveOutputTokens`; the runtime forwards it to
the selected backend without changing backend predicate selection or mutating
the original config. Tokens include system/context text, model-visible messages
and tool schemas; an injected tokenizer must return nonnegative safe integers.
Token estimates are not a provider billing guarantee.
The runtime's final gate counts the prepared backend messages and filtered tool
schemas, including the merged system layers, rather than trusting a pre-merge
projection estimate alone.

Compaction chooses a persisted checkpoint whose prefix has complete tool turns,
keeps the latest user request and recent complete/pending tool batches, and
appends a compaction entry with cumulative source IDs. Older history remains
inspectable. Historical summaries and latest authoritative project facts are
separate prompt layers, inserted before dynamic application context. Checkpoint
digests still validate raw confirmed history, not changing projections or facts.
Project identity/revision are rechecked after async preparation and before
confirming a model response. A project change during streaming cannot be adopted
as a new checkpoint and then used to execute a plan made for the old project;
reported model usage is still recorded for that rejected plan.

Large tool results retain their original JSON in an immutable artifact; projected
tool messages contain bounded `success`, `message`, `artifactId` and the same
toolCallId. Existing execution cache artifacts are reused. Missing/corrupt caches
reject rather than silently reexecute tools. `createContextManager({sessionId,
sessionStore, artifactStore, config?, summarize?})` also exposes
`project({llmConfig, systemPrompt, tools, projectFacts?, forceCompact?, signal?})`,
`countTokens(text)` and `getBudget(llmConfig)` independently of the runtime.

Only normalized `context_overflow` triggers recovery. At the same iteration the
runtime attempts forced compaction, halves the effective output cap, then filters
tool definitions by `hooks.filterTools`' returned registered tool names. Hosts
can derive this allowlist from active skills' `toolRefs`; an empty list removes
all tools, including the role-switch tool. A missing hook leaves tools unchanged.
There are at most three recovery attempts. Failed partial responses do not enter
confirmed history and their tool calls are not executed. RAG/dynamic/error context
is rebuilt before each attempt and after compaction. Storage failures propagate
with the original exception on every attempt, including the last; ordinary
provider errors do not acquire automatic retries.

Exhausted overflow emits `error` and `run_interrupted` with cause
`context_overflow`, saves recovery state, and leaves the same run resumable after
the host adjusts context/model/hooks. It does not append `run_failed` or add a
second user message on resume. Legacy `runAgentLoop`/`runAgentSession` retain their
original event/projection policy rather than silently enabling compaction.

## Development

```bash
bun install
bun test
bun run typecheck
npm run build
```

Tests have a separate no-emit TypeScript configuration to keep the package's
`dist/` layout unchanged. Full development builds include the optional Vercel
adapter and need the SDK development dependency. `npm run build:core` builds the
main entry without `ai`; consumers can import the package root without that peer.
Git-pinned releases must include the rebuilt `dist/` directory.


## Used by

- [RimeCut](https://github.com/nicepkg/rimecut) — AI-native video editor
- [RimeCraft](https://github.com/caozisheng/rimecraft) — Agentic chat-style game craft

## License

MIT
