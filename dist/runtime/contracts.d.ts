import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { DurableAgentTool } from "../tool-types";
import type { PromptLayer } from "../prompt-builder";
import type { RagBuilder, ErrorRecoveryBuilder } from "../rag-types";
import type { ToolFailureRecord } from "../session";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { AgentCheckpointRef } from "../store/checkpoint";
import type { AgentRuntimeEvent } from "../events";
import type { ContextManagerConfig, ContextSummarizer, HostSnapshot, AuthoritativeContext } from "./context-manager";
import type { RuntimeLedger } from "./ledger";
import type { ApprovalGate } from "./approval";
import type { ToolExecutorConfig } from "./executor";
export type AgentRuntimeState = "idle" | "running" | "interrupted" | "awaiting_approval" | "settled";
export interface AgentRuntimeConfig {
    readonly sessionId: string;
    readonly llmConfig: AgentLLMConfig;
    readonly expertRoleId: string;
    readonly sessionStore: AgentSessionStore;
    readonly ledger?: RuntimeLedger;
    readonly artifactStore?: AgentArtifactStore;
    readonly tools: readonly DurableAgentTool[];
    readonly executor?: ToolExecutorConfig;
    readonly approval?: ApprovalGate;
    readonly maxIterations?: number;
    readonly context?: ContextManagerConfig;
    readonly initialMessages?: readonly AgentMessage[];
    readonly activeRoleId?: string;
    readonly identityPrompt?: string;
    readonly workRules?: string;
    readonly customLayers?: PromptLayer[];
    readonly locale?: "zh" | "en";
    readonly switchRoleToolDef?: ToolDefinition;
    readonly hooks?: {
        readonly buildDynamicContext?: () => string | null;
        readonly buildRagContext?: RagBuilder;
        readonly buildErrorRecovery?: ErrorRecoveryBuilder;
        readonly onRoleSwitch?: (roleId: string) => AgentLLMConfig | void;
        readonly getHostSnapshot?: () => HostSnapshot | undefined;
        readonly summarizeContext?: ContextSummarizer;
        /** Host-owned toolRefs allowlist; definitions remain engine-owned. */
        readonly filterTools?: (tools: readonly ToolDefinition[], context: {
            activeRoleId: string;
            authoritativeContext?: AuthoritativeContext;
            failures: readonly ToolFailureRecord[];
        }) => readonly string[] | Promise<readonly string[]>;
    };
}
export interface AgentRuntime {
    readonly state: AgentRuntimeState;
    run(userMessage: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
    resume(runId: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
    resolveApproval(toolCallId: string, decision: "allow" | "deny", note?: string): Promise<void>;
    checkpoint(label?: string): Promise<AgentCheckpointRef>;
    abort(reason?: string): void;
}
//# sourceMappingURL=contracts.d.ts.map