import type { AgentMessage, ToolCall } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentCheckpointRef } from "../store/checkpoint";
import type { ToolFailureRecord } from "../session";
import type { ExternalStateBinding } from "../tool-types";
import type { HostSnapshot } from "./context-manager";
import type { RuntimeLedger } from "./ledger";
import type { RuntimeHistory } from "./history";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { AgentCheckpoint } from "../store/checkpoint";
import type { LedgerRecord } from "./ledger";
/** A checkpoint is immutable: only committed, matching execution records can advance its binding. */
export declare function verifiedStateBinding(checkpoint: AgentCheckpoint | AgentCheckpointRef, runId: string, entries: readonly AgentSessionEntry[], records: readonly LedgerRecord[], artifacts: AgentArtifactStore, checkpoints?: readonly AgentCheckpoint[]): Promise<ExternalStateBinding | undefined>;
export interface ResumeState {
    messages: AgentMessage[];
    userMessage: string;
    seq: number;
    iteration: number;
    phase: "model" | "tools" | "settled";
    activeRoleId: string;
    pendingToolCalls: ToolCall[];
    failures: ToolFailureRecord[];
    checkpoint: AgentCheckpointRef;
}
export declare function rejectRecovery(message: string): never;
export declare function assertNewRun(entries: readonly AgentSessionEntry[]): void;
/** Read-only preflight: nothing is appended and no model/tool is invoked on rejection. */
export declare function loadResumeState(history: RuntimeHistory, ledger: RuntimeLedger, runId: string, getSnapshot: (() => HostSnapshot | undefined) | undefined, artifacts: AgentArtifactStore): Promise<ResumeState>;
//# sourceMappingURL=recovery.d.ts.map