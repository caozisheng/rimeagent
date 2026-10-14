import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { ExternalStateBinding } from "../tool-types";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentArtifactStore } from "../store/artifact-store";
/** Model input budgeting is separate from immutable persisted conversation history. */
export interface ContextManagerConfig {
    readonly tokenizer?: (text: string) => number;
    readonly contextTokens?: number;
    readonly reserveOutputTokens?: number;
    readonly compactTriggerRatio?: number;
    readonly maxToolResultTokens?: number;
}
/** Host-produced model facts and execution state are independent snapshot fields. */
export interface AuthoritativeContext {
    readonly text: string;
    readonly producedBy: "host";
}
export interface HostSnapshot {
    readonly authoritativeContext?: AuthoritativeContext;
    readonly externalStateBinding?: ExternalStateBinding;
}
export interface ContextProjection {
    readonly messages: AgentMessage[];
    readonly tokensUsed: number;
    readonly compacted: boolean;
    readonly compaction?: {
        readonly droppedEntries: number;
        readonly summaryDigest: string;
    };
}
export interface ContextSummary {
    readonly goal: string;
    readonly constraints: string[];
    readonly completedWork: string[];
    readonly decisions: string[];
    readonly failedTools: string[];
    readonly openQuestions: string[];
    readonly nextSteps: string[];
    readonly references: string[];
}
export interface SummarizeContextInput {
    readonly previousSummary?: ContextSummary;
    readonly messages: readonly AgentMessage[];
    readonly authoritativeContext?: AuthoritativeContext;
    readonly signal?: AbortSignal;
}
export type ContextSummarizer = (input: SummarizeContextInput) => ContextSummary | Promise<ContextSummary>;
export interface ContextBudget {
    readonly contextTokens: number;
    readonly reserveOutputTokens: number;
    readonly inputTokens: number;
    readonly triggerTokens: number;
}
export interface ContextProjectInput {
    readonly llmConfig: AgentLLMConfig;
    readonly systemPrompt: string;
    readonly tools: readonly ToolDefinition[];
    readonly authoritativeContext?: AuthoritativeContext;
    readonly forceCompact?: boolean;
    readonly signal?: AbortSignal;
}
export interface ContextManagerOptions {
    readonly sessionId: string;
    readonly sessionStore: AgentSessionStore;
    readonly artifactStore: AgentArtifactStore;
    readonly config?: ContextManagerConfig;
    readonly summarize?: ContextSummarizer;
}
export interface ContextManager {
    project(input: ContextProjectInput): Promise<ContextProjection>;
    countTokens(text: string): number;
    getBudget(llmConfig: AgentLLMConfig): ContextBudget;
}
export declare function createContextManager(options: ContextManagerOptions): ContextManager;
//# sourceMappingURL=context-manager.d.ts.map