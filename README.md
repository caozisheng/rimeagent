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
contracts; durable sessions, checkpoints and approvals are not implemented yet.

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
