import type { AgentMessage } from "../types";
export interface AgentCheckpoint {
    readonly checkpointId: string;
    readonly sessionId: string;
    readonly parentId?: string;
    readonly createdAt: number;
    readonly entrySeq: number;
    readonly contextDigest: string;
    readonly label?: string;
}
export interface AgentCheckpointRef {
    readonly checkpointId: string;
    readonly sessionId: string;
    readonly projectId?: string;
    readonly projectRevision?: number;
    readonly projectCheckpointId?: string;
    readonly contextDigest: string;
}
/** References an agent history branch, never a project restore operation. */
export interface AgentBranch {
    readonly branchId: string;
    readonly sessionId: string;
    readonly fromCheckpointId: string;
}
/** Stable model-visible UTF-8 FNV-1a32 digest; not a security integrity hash. */
export declare function computeContextDigest(messages: readonly AgentMessage[]): string;
//# sourceMappingURL=checkpoint.d.ts.map