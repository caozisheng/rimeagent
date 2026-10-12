// Types
export type {
	AgentStatus,
	AgentLLMConfig,
	AgentMessage,
	AgentEvent,
	TokenUsage,
	ToolDefinition,
	ToolCall,
	ToolResultSummary,
	StreamChunk,
	OpenAIMessage,
	LLMProvider,
} from "./types";

// Tool system
export type { AgentTool, AgentToolAnnotations, AgentToolResult, ToolSuggestion } from "./tool-types";
export { agentToolToDefinition } from "./tool-types";
export type { ToolRegistryInstance } from "./tool-registry";
export { ToolRegistry, createToolRegistry } from "./tool-registry";

// LLM
export type { LLMBackend } from "./llm-backend";
export { RimeAgentBackend, shouldUseDirect } from "./llm-backend";
export { streamChatCompletion, getLLMBackend, registerLLMBackend, registerLLMBackendFor, resolveProvider } from "./llm-client";
export type { LLMBackendPredicate } from "./llm-client";

// Error policy (execution/retries remain runtime-owned)
export type { AgentErrorCategory, NormalizedError } from "./errors";
export { normalizeError } from "./errors";

// Expert roles
export type { ExpertRoleDefinition, ExpertRoleRegistryInstance } from "./expert-roles";
export { ExpertRoleRegistry, createExpertRoleRegistry } from "./expert-roles";

// Prompt builder
export type { PromptBuilderConfig, PromptLayer } from "./prompt-builder";
export { buildSystemPrompt } from "./prompt-builder";

// Skills
export type { AgentSkill, SkillRegistryInstance } from "./skills";
export { SkillRegistry, createSkillRegistry } from "./skills";

// MCP
export type { MCPToolProvider, MCPRegistryInstance } from "./mcp";
export { MCPRegistry, createMCPRegistry } from "./mcp";

// RAG types
export type { RetrievalConfig, ToolFailure, RagBuilder, ErrorRecoveryBuilder } from "./rag-types";

// Tool context types
export type { ToolContext, ToolFactory } from "./tool-context-types";

// Skill knowledge types
export type { SkillKnowledgeEntry, AgentSkillWithKnowledge } from "./skill-types";

// Service
export type { RunAgentLoopParams } from "./service";
export { runAgentLoop, SWITCH_ROLE_TOOL_NAME } from "./service";

// Session (high-level agent loop with iteration control)
export type { AgentSessionConfig, AgentSessionParams, AgentSessionEvent, ToolFailureRecord } from "./session";
export { runAgentSession } from "./session";

// Durable runner contracts (Phase 2; execution stays in the existing entrypoints)
export { AGENT_RUNTIME_EVENT_VERSION, createAgentRuntimeEvent, parseAgentRuntimeEvent } from "./events";
export type { AgentRuntimeEvent, AgentRuntimeEventPayload, AgentRuntimeEventEnvelope } from "./events";
export { isAgentSessionEntry, serializeAgentSessionEntry, parseAgentSessionEntry } from "./store/entries";
export type { AgentSessionEntry, AgentSessionSnapshot } from "./store/entries";
export { InMemorySessionStore } from "./store/session-store";
export type { AgentSessionStore } from "./store/session-store";
export { computeContextDigest } from "./store/checkpoint";
export type { AgentCheckpoint, AgentCheckpointRef, AgentBranch } from "./store/checkpoint";
export { InMemoryArtifactStore } from "./store/artifact-store";
export type { AgentArtifact, AgentArtifactStore } from "./store/artifact-store";
export type { JsonValue } from "./store/json";
export { InMemoryLedger, isLedgerRecord } from "./runtime/ledger";
export type { ApprovalDecision, LedgerRecord, RuntimeLedger } from "./runtime/ledger";
export { createToolExecutor } from "./runtime/executor";
export type { ToolExecutor, ToolExecutorOptions, ToolExecutorContext } from "./runtime/executor";
export { createContextManager } from "./runtime/context-manager";
export type {
	ContextManagerConfig, ContextProjection, ProjectFactsDigest, ContextManager, ContextManagerOptions,
	ContextProjectInput, ContextBudget, ContextSummary, SummarizeContextInput, ContextSummarizer,
} from "./runtime/context-manager";

// Agent run lifecycle, durable recovery and context management (Phase 3–5)
export { createAgentRuntime } from "./runtime/runtime";
export type { AgentRuntime, AgentRuntimeConfig, AgentRuntimeState } from "./runtime/runtime";
