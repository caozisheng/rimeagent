import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { AgentTool } from "../tool-types";
import type { PromptLayer } from "../prompt-builder";
import type { RagBuilder, ErrorRecoveryBuilder } from "../rag-types";
import type { AgentSessionConfig, AgentSessionParams } from "../session";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentCheckpointRef } from "../store/checkpoint";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { AgentRuntimeEvent } from "../events";
import type { ContextManagerConfig, ContextSummarizer, ProjectFactsDigest } from "./context-manager";
import type { ToolFailureRecord } from "../session";
import type { RuntimeLedger } from "./ledger";
export type AgentRuntimeState = "idle" | "running" | "interrupted" | "settled";
export interface AgentRuntimeConfig {
    readonly sessionId: string;
    readonly llmConfig: AgentLLMConfig;
    readonly expertRoleId: string;
    readonly sessionStore: AgentSessionStore;
    readonly ledger?: RuntimeLedger;
    readonly artifactStore?: AgentArtifactStore;
    readonly tools: readonly AgentTool[];
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
        readonly getProjectFacts?: () => ProjectFactsDigest;
        readonly summarizeContext?: ContextSummarizer;
        /** Host returns tool names from active skills' toolRefs; definitions stay engine-owned. */
        readonly filterTools?: (tools: readonly ToolDefinition[], context: {
            activeRoleId: string;
            projectFacts?: ProjectFactsDigest;
            failures: readonly ToolFailureRecord[];
        }) => readonly string[] | Promise<readonly string[]>;
    };
}
export interface AgentRuntime {
    readonly state: AgentRuntimeState;
    run(userMessage: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
    resume(runId: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
    checkpoint(label?: string): Promise<AgentCheckpointRef>;
    abort(reason?: string): void;
}
/** Durable run lifecycle and confirmed-message history. */
export declare function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime;
/** Internal bridge: legacy sessions add no user input and expose their original callback values. */
export declare function createSessionRuntime(params: AgentSessionParams, config: AgentSessionConfig): AsyncGenerator<AgentRuntimeEvent>;
//# sourceMappingURL=runtime.d.ts.map