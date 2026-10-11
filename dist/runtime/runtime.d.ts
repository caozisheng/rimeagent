import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { AgentTool } from "../tool-types";
import type { PromptLayer } from "../prompt-builder";
import type { RagBuilder, ErrorRecoveryBuilder } from "../rag-types";
import type { AgentSessionConfig, AgentSessionParams } from "../session";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentCheckpointRef } from "../store/checkpoint";
import type { AgentRuntimeEvent } from "../events";
export type AgentRuntimeState = "idle" | "running" | "interrupted" | "settled";
export interface AgentRuntimeConfig {
    readonly sessionId: string;
    readonly llmConfig: AgentLLMConfig;
    readonly expertRoleId: string;
    readonly sessionStore: AgentSessionStore;
    readonly tools: readonly AgentTool[];
    readonly maxIterations?: number;
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
    };
}
export interface AgentRuntime {
    readonly state: AgentRuntimeState;
    run(userMessage: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
    checkpoint(label?: string): Promise<AgentCheckpointRef>;
    abort(reason?: string): void;
}
/** Run lifecycle and confirmed-message history; disk recovery is added in Phase 4. */
export declare function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime;
/** Internal bridge: the legacy session has no additional user input or public v2 events. */
export declare function createSessionRuntime(params: AgentSessionParams, config: AgentSessionConfig): AsyncGenerator<AgentRuntimeEvent>;
//# sourceMappingURL=runtime.d.ts.map