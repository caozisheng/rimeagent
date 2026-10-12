import type { ToolCall } from "../types";
import type { AgentTool, AgentToolResult } from "../tool-types";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { RuntimeLedger } from "./ledger";
export interface ToolExecutorContext {
    readonly runId: string;
    readonly nextSeq: () => number;
    readonly signal?: AbortSignal;
}
export interface ToolExecutor {
    execute(call: ToolCall, context: ToolExecutorContext): Promise<AgentToolResult>;
}
export interface ToolExecutorOptions {
    readonly sessionId: string;
    readonly tools: readonly AgentTool[];
    readonly ledger: RuntimeLedger;
    readonly artifactStore: AgentArtifactStore;
}
export declare function createToolExecutor(options: ToolExecutorOptions): ToolExecutor;
//# sourceMappingURL=executor.d.ts.map