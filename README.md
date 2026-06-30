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

## Used by

- [RimeCut](https://github.com/nicepkg/rimecut) — AI-native video editor
- [RimeCraft](https://github.com/caozisheng/rimecraft) — Agentic chat-style game craft

## License

MIT
