import type { AgentErrorCategory, NormalizedError } from "../errors";
import type { AgentToolResult } from "../tool-types";
import type { TokenUsage, ToolCall } from "../types";
import type { ProjectFactsDigest } from "../runtime/context-manager";
import { isAgentSessionEntry } from "./validation";
export { isAgentSessionEntry };
export type AgentSessionEntry = {
    kind: "user_message";
    id: string;
    ts: number;
    content: string;
} | {
    kind: "assistant_message";
    id: string;
    ts: number;
    content: string;
    toolCalls?: ToolCall[];
    usage?: TokenUsage;
} | {
    kind: "tool_call";
    id: string;
    ts: number;
    toolCallId: string;
    name: string;
    argsDigest: string;
} | {
    kind: "tool_result";
    id: string;
    ts: number;
    toolCallId: string;
    result: AgentToolResult;
    artifactId?: string;
} | {
    kind: "approval_requested";
    id: string;
    ts: number;
    toolCallId: string;
    reason: string;
    runId?: string;
    argsDigest?: string;
    projectId?: string;
    projectRevision?: number;
    proposalDigest?: string;
    artifactId?: string;
} | {
    kind: "approval_resolved";
    id: string;
    ts: number;
    toolCallId: string;
    decision: "allow" | "deny";
    by: "user" | "policy";
    runId?: string;
    note?: string;
    proposalDigest?: string;
} | {
    kind: "proposal";
    id: string;
    ts: number;
    toolCallId: string;
    proposalDigest: string;
    artifactId: string;
} | {
    kind: "compaction";
    id: string;
    ts: number;
    summary: string;
    compactedEntryIds: string[];
    projectDigest: ProjectFactsDigest;
} | {
    kind: "checkpoint";
    id: string;
    ts: number;
    checkpointId: string;
    projectRevision?: number;
} | {
    kind: "branch";
    id: string;
    ts: number;
    fromCheckpointId: string;
    branchId: string;
} | {
    kind: "run_started";
    id: string;
    ts: number;
    runId: string;
    parentRunId?: string;
} | {
    kind: "run_interrupted";
    id: string;
    ts: number;
    runId: string;
    cause: AgentErrorCategory;
    lastDurableBoundary?: string;
} | {
    kind: "run_awaiting_approval";
    id: string;
    ts: number;
    runId: string;
    toolCallId: string;
} | {
    kind: "run_completed";
    id: string;
    ts: number;
    runId: string;
    reason?: "response" | "max_iterations";
    iterations?: number;
} | {
    kind: "run_failed";
    id: string;
    ts: number;
    runId: string;
    error: NormalizedError;
} | {
    kind: "error";
    id: string;
    ts: number;
    error: NormalizedError;
} | {
    kind: "usage";
    id: string;
    ts: number;
    runId: string;
    usage: TokenUsage;
} | {
    kind: "run_state";
    id: string;
    ts: number;
    runId: string;
    seq: number;
    iteration: number;
    phase: "model" | "tools" | "settled";
    activeRoleId: string;
    checkpointId?: string;
};
export interface AgentSessionSnapshot {
    readonly sessionId: string;
    readonly entries: AgentSessionEntry[];
}
export declare function serializeAgentSessionEntry(entry: AgentSessionEntry): string;
export declare function parseAgentSessionEntry(json: string): AgentSessionEntry;
//# sourceMappingURL=entries.d.ts.map