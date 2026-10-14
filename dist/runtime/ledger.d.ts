import type { AgentErrorCategory } from "../errors";
import type { TokenUsage } from "../types";
import type { ExecutionReceipt } from "../tool-types";
export type ApprovalDecision = "allow" | "deny" | "suspend";
export interface LedgerRecord {
    readonly runId: string;
    readonly seq: number;
    readonly ts: number;
    readonly event: {
        kind: "model_call";
        provider: string;
        model: string;
        requestIndex: number;
        usage: TokenUsage;
    } | {
        kind: "tool_intent";
        toolCallId: string;
        tool: string;
        argsDigest: string;
    } | {
        kind: "tool_exec";
        toolCallId: string;
        tool: string;
        argsDigest: string;
        outcome: "success" | "failure";
        messageDigest: string;
        artifactId?: string;
        receipt?: ExecutionReceipt;
    } | {
        kind: "retry";
        toolCallId?: string;
        attempt: number;
        category: AgentErrorCategory;
    } | {
        kind: "approval";
        toolCallId: string;
        decision: ApprovalDecision;
    } | {
        kind: "terminal";
        status: "completed" | "failed" | "interrupted" | "awaiting_approval";
    } | {
        kind: "compaction" | "cancellation";
        detail?: string;
    };
}
export interface RuntimeLedger {
    append(record: LedgerRecord): Promise<void>;
    /** Successful tool executions only; toolCallId is global across runs. */
    hasExecuted(toolCallId: string): Promise<boolean>;
    /** Global replay lookup: successful execution dominates later failures. */
    getToolExecution(toolCallId: string): Promise<LedgerRecord | null>;
    query(runId: string): Promise<LedgerRecord[]>;
}
export declare function isLedgerRecord(value: unknown): value is LedgerRecord;
/**
 * Append-only in-memory history. Only allowlisted fields are accepted; supplied
 * digest/detail strings are not inspected for semantic secrets or redacted.
 */
export declare class InMemoryLedger implements RuntimeLedger {
    private readonly recordsByRun;
    private readonly successfulToolCallIds;
    private readonly successfulExecutions;
    private readonly latestToolRecords;
    private readonly claimedIntents;
    append(record: LedgerRecord): Promise<void>;
    hasExecuted(toolCallId: string): Promise<boolean>;
    getToolExecution(toolCallId: string): Promise<LedgerRecord | null>;
    query(runId: string): Promise<LedgerRecord[]>;
}
//# sourceMappingURL=ledger.d.ts.map