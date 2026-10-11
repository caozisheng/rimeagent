# rimeagent

Host-agnostic LLM agent engine with tool registry, streaming, and expert role orchestration.

## Features

- **Multi-provider LLM streaming** — OpenAI-compatible and Anthropic native, with pluggable backends
- **Tool calling** — Registry-based tool system with typed definitions and execution
- **Expert roles** — Orchestrator mode with dynamic role switching
- **Skills** — Skill registry with prompt layers and tool refs
- **MCP support** — Model Context Protocol tool provider integration
- **Session management** — Multi-iteration agent loop with tool execution and failure recovery

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
0.5.0 now uses session history and checkpoints during runs; disk adapters and
cross-process recovery remain later phases. The legacy session wrapper uses an
isolated in-memory runtime while retaining its original event and callback API.

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
- `InMemoryLedger`: `append`, `query(runId)`, `hasExecuted(toolCallId)`. Positive
  safe-integer sequences strictly increase per run (gaps allowed). Only successful
  tool executions mark the global replay query; this is not an executor lock or
  automatic replay protection on its own.
- `serializeAgentSessionEntry` / `parseAgentSessionEntry` validate all 16 kinds
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
  serial/parallel metadata without entering the LLM schema. Scheduling and
  approval enforcement remain later phases.

The memory stores are volatile. They do not claim persistence across process
restarts or recovery of an interrupted run. Context types and
`ProjectFactsDigest.producedBy: "host"` are frozen; there is no compaction engine
yet. The reusable `./contract` suite will be published in its later design phase.

## Agent runtime (0.5.0)

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

Each run has an independent ID and increasing sequence. The same runtime instance
rejects overlapping runs. `state` exposes idle/running/interrupted/settled;
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

This version is not crash-recoverable. There is no `resume()` or
`resolveApproval()` placeholder; those methods arrive with their real features.
If an interrupted batch still has unresolved tool calls, a fresh run in the same
session fails explicitly before requesting the model. History is not silently
dropped; use a new session until durable recovery is implemented.
New runtime tools marked destructive/requiresApproval/requiresConfirmation return
a failure before execution; the existing session callback policy is untouched.
Tool scheduling is serial. Compaction, output/artifact budgets, persistent ledger
replay enforcement and durable adapters are not yet wired into execution.

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
