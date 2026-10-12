import type { ToolCall } from "../types";
import type { AgentRuntimeEventPayload } from "../events";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { RuntimeLedger, LedgerRecord } from "./ledger";
import type { RuntimeHistory } from "./history";
import type { ProjectFactsDigest } from "./context-manager";
import type { ApprovalGate } from "./approval";
import type { ToolExecutor, ToolExecutorContext } from "./executor";
export interface RuntimeApprovalOptions {
    sessionId: string;
    sessionStore: AgentSessionStore;
    artifactStore: AgentArtifactStore;
    ledger: RuntimeLedger;
    history: RuntimeHistory;
    executor: ToolExecutor;
    gate: ApprovalGate;
    facts?: () => ProjectFactsDigest;
    onPersistenceFailure: () => void;
}
export interface ApprovalBatchContext extends ToolExecutorContext {
    checkpoint: () => Promise<unknown>;
    recordLedger: (event: LedgerRecord["event"]) => Promise<void>;
}
export type ApprovalBatchResult = {
    status: "ready";
    decisions: Readonly<Record<string, "allow" | "deny">>;
} | {
    status: "awaiting_approval";
    events: AgentRuntimeEventPayload[];
};
export declare function createRuntimeApproval(options: RuntimeApprovalOptions): {
    assertBinding(call: ToolCall, runId: string): Promise<void>;
    prepare(calls: readonly ToolCall[], context: ApprovalBatchContext): Promise<ApprovalBatchResult>;
    resolve(toolCallId: string, decision: "allow" | "deny", note?: string): Promise<void>;
};
//# sourceMappingURL=approval-controller.d.ts.map