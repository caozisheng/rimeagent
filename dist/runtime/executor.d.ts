import type { ToolCall } from "../types";
import type { AgentTool, AgentToolResult } from "../tool-types";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { RuntimeLedger } from "./ledger";
import type { ProjectFactsDigest } from "./context-manager";
import type { ApprovalGate, PreflightDecision } from "./approval";
export interface ToolExecutorContext {
    readonly runId: string;
    readonly nextSeq: () => number;
    readonly signal?: AbortSignal;
    /** Reads the host's current project identity at approval time. */
    readonly projectFacts?: () => ProjectFactsDigest | undefined;
    /** Durable, call-specific decisions validated by the runtime before execution. */
    readonly approvalDecisions?: Readonly<Record<string, "allow" | "deny">>;
    /** Marks adapter failures during preflight without changing the original exception. */
    readonly onPersistenceFailure?: () => void;
}
export interface ToolExecutor {
    execute(call: ToolCall, context: ToolExecutorContext): Promise<AgentToolResult>;
    preflight(call: ToolCall, context: ToolExecutorContext): Promise<PreflightDecision>;
    executeBatch(calls: readonly ToolCall[], context: ToolExecutorContext): Promise<AgentToolResult[]>;
}
/** Scheduler policy. Read-only parallelism is opt-in to preserve phase 4 ordering. */
export interface ToolExecutorConfig {
    readonly parallelReadOnly?: boolean;
}
export interface ToolExecutorOptions {
    readonly sessionId: string;
    readonly tools: readonly AgentTool[];
    readonly ledger: RuntimeLedger;
    readonly artifactStore: AgentArtifactStore;
    readonly approval?: ApprovalGate;
    readonly executor?: ToolExecutorConfig;
}
export declare class ApprovalRequiredError extends Error {
    readonly toolCall: ToolCall;
    readonly decision: Extract<PreflightDecision, {
        action: "suspend";
    }>;
    constructor(toolCall: ToolCall, decision: Extract<PreflightDecision, {
        action: "suspend";
    }>);
}
export declare function createToolExecutor(options: ToolExecutorOptions): ToolExecutor;
//# sourceMappingURL=executor.d.ts.map