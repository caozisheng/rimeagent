import type { ToolCall } from "../types";
import type { DurableAgentTool, AgentToolResult, ExternalStateBinding } from "../tool-types";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { RuntimeLedger } from "./ledger";
import type { HostSnapshot } from "./context-manager";
import type { ApprovalGate, PreflightDecision } from "./approval";
export interface ToolExecutorContext {
    readonly runId: string;
    readonly nextSeq: () => number;
    readonly signal?: AbortSignal;
    /** A coherent current host snapshot, including the external state binding. */
    readonly getHostSnapshot?: () => HostSnapshot | undefined;
    /** Bound run's latest verified state. Missing snapshots fail closed. */
    readonly expectedBinding?: () => Promise<ExternalStateBinding | undefined>;
    /** Advances the active run only after a validated execution and ledger commit. */
    readonly onCommittedStateChange?: (after: ExternalStateBinding) => void;
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
    readonly tools: readonly DurableAgentTool[];
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