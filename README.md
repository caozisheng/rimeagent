# rimeagent

`rimeagent` is a host-neutral TypeScript agent runtime. It provides LLM routing, tool calling, durable approval and replay protection, append-only session history, context budgeting/compaction, and optional IndexedDB persistence. The engine does not depend on an editor, project document, React, Tauri, or DOM. A host supplies tools and, when it has externally mutable state, one coherent `HostSnapshot`.

## Install and exports

```sh
# After 0.9.0 is published:
npm install rimeagent@0.9.0
# Until publication, consume an authorized Git commit that includes dist/ and pin its SHA.
```

The source package is ESM and currently declares `0.9.0` (unreleased). An `npm install rimeagent@0.9.0` command will not provide these APIs until publication; host Git pins must refer to a built, reachable commit. The root export contains the neutral runtime, legacy loop/session entrypoints, stores, validation types, and migration converters. The optional Web adapter is `rimeagent/adapters/web`; the Vercel transport is `rimeagent/backends/vercel`. The package does not eagerly load IndexedDB or an AI SDK.

```ts
import {
  createAgentRuntime,
  InMemorySessionStore,
  InMemoryArtifactStore,
  InMemoryLedger,
} from "rimeagent";
```

## Backend registration

The runtime preserves the existing provider routing contract. Register a backend before starting a run; the predicate is matched against the same `AgentLLMConfig` object used by the runtime.

```ts
import { registerLLMBackendFor, RimeAgentBackend } from "rimeagent";
import type { AgentLLMConfig } from "rimeagent";

const llmConfig: AgentLLMConfig = {
  baseUrl: "https://api.openai.com/v1", // replace with your compatible API endpoint
  apiKey: "YOUR_API_KEY", // host injects a real secret; never persist it
  model: "YOUR_MODEL_ID", // choose a model available at that endpoint
  provider: "openai",
  directMode: true,
};

// The built-in backend speaks OpenAI-compatible streaming responses in direct mode.
const unregister = registerLLMBackendFor(candidate => candidate === llmConfig, new RimeAgentBackend());
// Call unregister() when this host's backend route is no longer needed.
```

Hosts should register one backend per routing boundary and keep credentials out of session entries, artifacts, result data, and ledger records.

Default routing without registration uses `RimeAgentBackend`. `directMode: true` sends the provider-compatible stream to `baseUrl/chat/completions`; proxy mode uses the host `/api/ai/chat` route. `registerLLMBackendFor` installs a predicate-scoped override and returns an unregister function. `registerLLMBackend` sets a global override. `getLLMBackend` and `resolveProvider` expose the selected backend/provider for diagnostics. Optional `VercelAIBackend` from `rimeagent/backends/vercel` accepts a host-owned `(config) => LanguageModel | Promise<LanguageModel>` resolver (Vercel AI SDK peer dependency); the host chooses credentials/model provider. Neither adapter creates a second agent loop.

## Simplest stateless host

A host with no externally mutable resource does not need to invent a project or revision. Omit `getHostSnapshot`, provide a real stateless host lookup, and use memory stores for an in-process run.

```ts
import {
  createAgentRuntime,
  InMemorySessionStore,
  InMemoryArtifactStore,
  InMemoryLedger,
} from "rimeagent";

// Implement this read-only lookup using your host's real search API.
declare function hostSearch(query: string): Promise<string[]>;


const runtime = createAgentRuntime({
  sessionId: "search-session",
  expertRoleId: "general",
  llmConfig,
  sessionStore: new InMemorySessionStore(),
  artifactStore: new InMemoryArtifactStore(),
  ledger: new InMemoryLedger(),
  tools: [{
    name: "search",
    description: "Search the host's index without changing state.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnly: true, idempotent: true, executionMode: "parallel" },
    async execute(args) {
      if (typeof args.query !== "string") return { result: { success: false, message: "query must be a string" } };
      const items = await hostSearch(args.query); // host-owned real lookup; inject your implementation
      return { result: { success: true, message: `Found ${items.length} records`, data: { items } } };
    },
  }],
});

for await (const event of runtime.run("Find matching records")) {
  console.log(event.type, event.payload);
}
```

A missing state binding is intentional: this run does not claim to protect an external resource from concurrent changes. It can still use approval, durable history, and no-project compaction when a safe checkpoint exists.

## HostSnapshot and opaque versions

`HostSnapshot` is one coherent synchronous read. Its fields have independent meanings:

- `authoritativeContext` is optional host-produced text for model projection.
- `externalStateBinding` is optional execution/approval state: non-empty `scopeId` and opaque non-empty `version`.

The engine never assumes the version is an integer, compares it arithmetically, or places it in model facts. These are valid host mappings:

```ts
import type { HostSnapshot } from "rimeagent";

const etagSnapshot: HostSnapshot = {
  authoritativeContext: { text: "Resource body", producedBy: "host" },
  externalStateBinding: { scopeId: "https://example.invalid/doc", version: 'W/"etag-42"' },
};
const gitSnapshot: HostSnapshot = {
  externalStateBinding: { scopeId: "repository", version: "b8820fbe88c7" },
};
const editorSnapshot: HostSnapshot = {
  authoritativeContext: { text: "Current document", producedBy: "host" },
  externalStateBinding: { scopeId: "document-id", version: String(42) },
};

// Supply one host-owned synchronous read in runtime.hooks:
const getHostSnapshot = (): HostSnapshot => etagSnapshot;
```

Read the descriptor and authoritative text from the same host snapshot. Never construct a binding from tool result data, an old summary, a timeline label, or two separately sampled host calls.

## DurableAgentTool and ExecutionReceipt

New runtime tools return a durable envelope. `result` remains model-visible business output; `receipt` is execution evidence for the ledger and recovery path and is never included in the model tool result or result artifact.

```ts
import type { DurableAgentTool, ExternalStateBinding, HostSnapshot } from "rimeagent";

interface CommitResponse { operationId: string; after: ExternalStateBinding }
interface ResourceHost {
  getSnapshot(): HostSnapshot;
  commit(value: string, expected: ExternalStateBinding): Promise<CommitResponse>;
}

function updateTool(host: ResourceHost): DurableAgentTool {
  return {
    name: "update_resource",
    description: "Commit one update to the resource.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    annotations: { readOnly: false, idempotent: false, executionMode: "serial", requiresApproval: true },
    async execute(args) {
      const before = host.getSnapshot().externalStateBinding;
      if (!before) throw new Error("A resource update requires a state binding");
      const committed = await host.commit(String(args.value), before); // host atomically enforces expected version
      return { result: { success: true, message: "Updated" },
        receipt: { operationId: committed.operationId, stateChange: { before, after: committed.after } } };
    },
  };
}
```

The host must return the real committed operation ID and state transition. The adapter must not guess an ID, infer before/after values by calling `describe()` twice, or copy reserved-looking business fields into a receipt. Arbitrary business JSON such as `{ commandId: 42, projectRevisionBefore: "etag" }` remains ordinary `result.data`.

Old `AgentTool.execute` functions that return a bare `AgentToolResult` remain supported only at legacy `runAgentLoop`/`runAgentSession` boundaries. New durable runtime configuration uses `DurableAgentTool`; there is no public editor-shaped `ToolContext` or `ToolFactory`.

## Annotations and scheduling

Scheduling is capability-only. With `executor: { parallelReadOnly: true }`, only adjacent tools marked both `readOnly: true` and `executionMode: "parallel"` are grouped and run concurrently. Every other tool is serial, including tools named `undo`, `redo`, `restore`, `project.undo`, or anything else. Results retain model order and a serial tool is a strict barrier.

Use `destructive` or `requiresApproval` to request approval, and `idempotent` only when the host can safely retry after an uncertain effect. Do not mark a mutating tool idempotent merely because it usually succeeds.

Low-level `createToolExecutor` callers that supply a bound `getHostSnapshot` must also supply `expectedBinding` from their own validated checkpoint/ledger chain; a bound call without that expected version fails closed. Normal `createAgentRuntime` wires this validation automatically. A stateless low-level tool needs neither hook. `executeBatch` retains model result order after parallel read groups; cancellation starts no new batch.

## Approval, suspension, resolution, and resume

A suspended tool persists the request binding (run, call, argument digest, proposal artifact/digest, and optional external state binding), an approval ledger event, a durable run cursor, and a checkpoint before emitting `run_awaiting_approval`.

```ts
import type { AgentRuntime, AgentRuntimeEvent } from "rimeagent";

async function reviewPending(runtime: AgentRuntime): Promise<void> {
  const waiting: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run("Publish the report")) waiting.push(event);
  const approval = waiting.find(event => event.type === "run_awaiting_approval");
  if (!approval || approval.payload.kind !== "run_awaiting_approval") return;
  await runtime.resolveApproval(approval.payload.toolCallId, "allow", "Reviewed by operator");
  for await (const event of runtime.resume(approval.runId)) console.log(event.type);
}
```

A deny decision is durable and prevents execution. Repeated identical resolution is idempotent; conflicting resolution, changed arguments, changed proposal, changed scope/version, or missing host binding is rejected. Completed cached outcomes win over a newly changed approval policy and are replayed without invoking the tool again.

## Stores, schema 2, and IndexedDB migration

The durable interfaces are injected independently:

```ts
import { createAgentRuntime, AGENT_STORE_SCHEMA_VERSION } from "rimeagent";
import { createIndexedDBStores } from "rimeagent/adapters/web";
import type { AgentLLMConfig, DurableAgentTool } from "rimeagent";

async function openWebRuntime(sessionId: string, llmConfig: AgentLLMConfig, tools: DurableAgentTool[]) {
  const stores = await createIndexedDBStores({ name: "host-agent" });
  console.log(AGENT_STORE_SCHEMA_VERSION); // 2
  const runtime = createAgentRuntime({ sessionId, ...stores, llmConfig, expertRoleId: "general", tools });
  return { runtime, stores }; // Call stores.close() on teardown.
}
```

Schema 2 keeps the existing database name and upgrades IndexedDB version 1 transactionally. Before conversion it copies original rows to `legacyBackup`; it validates store/index shape, session counts, entry/checkpoint/artifact/ledger references, checkpoint digests, proposal artifacts, tool-call/argument digests, and committed ledger metadata. Old `projectId + projectRevision` is converted only as a verified pair to `{ scopeId, version: String(projectRevision) }`. Old command/revision metadata is converted to a receipt only from committed ledger records; model-visible `result.data` is never scanned for historical receipts.

Migrated old tool-result JSON, including historical `undoable` where present, is never rewritten: preserving its model projection keeps checkpoint digests stable. Only migrated records carry the explicit `legacyResult: true` storage marker; new durable entries reject UI-only metadata.

Upgrade failures abort the transaction, preserving the original version-one DB. A successful upgrade retains original rows in `legacyBackup`, but an old version-one host pin **cannot open the migrated version-two DB directly**. Before switching pins, back up the host DB and pause runs/resolves. For manual rollback, use `exportLegacyIndexedDBBackup(indexedDB, name)` and `restoreLegacyIndexedDBBackup(indexedDB, migratedName, separateTargetName)` from `rimeagent/adapters/web`; point the old host pin to that separate version-one target only after verifying the restored record counts. Never write both schemas into the same DB. Unknown schema, orphan rows, digest mismatch, ambiguous active cursor, uncertain intent-only effect, cross-session reference, incomplete binding, or missing committed receipt blocks migration. Conversion does not execute tools, call the model, or resolve approvals.

## Compaction and summarization

`ContextSummary` uses the domain-neutral `completedWork` field. A host summarizer receives previous summary, safe-cut messages, and optional current `authoritativeContext`; it does not receive an external version token as model authority.

```ts
import { createAgentRuntime } from "rimeagent";
import type { AgentRuntimeConfig, ContextSummary, HostSnapshot } from "rimeagent";

function withCompaction(config: AgentRuntimeConfig, snapshot: () => HostSnapshot | undefined) {
  return createAgentRuntime({ ...config,
    context: { contextTokens: 32768, reserveOutputTokens: 4096, compactTriggerRatio: 0.8 },
    hooks: { ...config.hooks, getHostSnapshot: snapshot,
      summarizeContext: ({ previousSummary, messages, signal }): ContextSummary => {
        signal?.throwIfAborted();
        const latestRequest = messages.findLast(message => message.role === "user")?.content;
        const goal = previousSummary?.goal ?? latestRequest;
        if (!goal?.trim()) throw new Error("Cannot summarize without a confirmed goal");
        return {
          goal,
          constraints: previousSummary?.constraints ?? [],
          completedWork: previousSummary?.completedWork ?? [],
          decisions: previousSummary?.decisions ?? [],
          failedTools: previousSummary?.failedTools ?? [],
          openQuestions: previousSummary?.openQuestions ?? [],
          nextSteps: previousSummary?.nextSteps ?? [],
          references: previousSummary?.references ?? [],
        };
      },
    },
  });
}

// This conservative summarizer only carries previously verified work forward.
// A domain-specific summarizer may add work/decisions only after checking confirmed messages.
```

Compaction selects a persisted safe checkpoint, never cuts through a tool batch, appends a cumulative compaction entry, and leaves old entries inspectable. Current host text and historical summary are separate prompt layers. A missing summarizer, missing safe cut, or absent project does not cause fake facts, fabricated completed work, or silent deletion.

## Recovery and fail-closed rules

Intent, execution, artifact, ledger, and session-result persistence are separate commits. A successful host effect followed by an artifact/ledger fault is reported as the original persistence error and is not retried as a normal tool failure. An intent without a committed execution is uncertain: non-idempotent tools are blocked; only explicitly safe read-only/idempotent operations may retry.

Recovery verifies run/session/call/argument/artifact bindings and walks receipt state changes as a continuous `before → after` chain with one scope. A version change without a matching receipt cannot be adopted by a new checkpoint. A missing snapshot hook for a bound run, wrong scope/version, corrupt artifact, cross-run ledger record, discontinuous chain, or altered checkpoint digest fails closed. A receipt is evidence, not an exactly-once guarantee; hosts still need command-log/idempotency protection for a crash between host commit and ledger commit.

## Web adapter requirements

`rimeagent/adapters/web` requires a browser `indexedDB`, `Promise.withResolvers`, and `Array.findLast`. Adapter methods resolve only after IndexedDB transaction commit and reject blocked opens, quota errors, schema errors, and transaction aborts. Call `stores.close()` on teardown. Do not mix Web/Tauri storage paths or write old and new schemas concurrently.

## Legacy loop/session boundary

`runAgentLoop` and `runAgentSession` retain their established callback signatures, bare `AgentToolResult` execution, event v2 behavior, backend routing, and compatibility semantics. Legacy UI fields such as `undoable` and `commandCheckpoint` may remain at that explicit compatibility or host-display boundary. They are not written into new durable result envelopes, receipts, checkpoints, or core context summaries.

## Errors and events

Runtime events are versioned (`AGENT_RUNTIME_EVENT_VERSION`) and carry run IDs and monotonic sequence numbers. `run_awaiting_approval`, `run_completed`, `run_failed`, and `run_interrupted` distinguish policy suspension, successful completion, provider/tool/persistence failure, and cancellation. Persistence faults are not disguised as ordinary tool failures. Use `normalizeError` for errors crossing a host boundary and `parseAgentRuntimeEvent` for untrusted serialized events.
```ts
import type { AgentRuntime } from "rimeagent";

async function runWithCancellation(runtime: AgentRuntime, userText: string, signal: AbortSignal) {
  try {
    for await (const event of runtime.run(userText, signal)) {
      if (event.type === "run_failed") console.error(event.payload.error.message);
      if (event.type === "run_awaiting_approval") console.log("Approval pending", event.payload.toolCallId);
      if (event.type === "run_interrupted") console.log("Interrupted", event.payload.cause);
      if (event.type === "run_completed") console.log("Completed", event.payload.reason);
    }
  } catch (error) {
    // Storage and uncertain-effect faults reject rather than masquerade as tool failures.
    console.error("Durable run rejected", error);
    throw error;
  }
}
```


## Verification

From the rimeagent repository root:

```sh
bun test
bun run typecheck
npm run build
bun run build:core
```

The complete acceptance surface includes stateless/no-project compaction, opaque ETag/SHA versions, receipt/result namespace separation, annotation-only scheduling, approval suspension and cached replay, strict continuous state chains, uncertain-effect blocking, transactional schema-2 migration with backup/rollback, and legacy loop/session compatibility. Host integration must additionally exercise real Web/Tauri persistence, command expected-version checks, HTTP/SSE transport, refresh/resume, and UI approval behavior.

## License and provenance

This project is released under the MIT License; see [LICENSE](LICENSE). The engine's design history and domain-neutral migration specification are maintained in [docs/rimeagent-design.md](docs/rimeagent-design.md). Editor/project-specific adapters belong in the host repository.
