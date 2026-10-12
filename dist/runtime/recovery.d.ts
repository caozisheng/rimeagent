import type { AgentMessage, ToolCall } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentCheckpointRef } from "../store/checkpoint";
import type { ToolFailureRecord } from "../session";
import type { ProjectFactsDigest } from "./context-manager";
import type { RuntimeLedger } from "./ledger";
import type { RuntimeHistory } from "./history";
import type { AgentArtifactStore } from "../store/artifact-store";
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
export declare function loadResumeState(history: RuntimeHistory, ledger: RuntimeLedger, runId: string, facts: ProjectFactsDigest | undefined, artifacts: AgentArtifactStore): Promise<ResumeState>;
//# sourceMappingURL=recovery.d.ts.map