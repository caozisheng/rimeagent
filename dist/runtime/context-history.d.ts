import type { AgentMessage } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentCheckpoint } from "../store/checkpoint";
import type { ContextSummary } from "./context-manager";
export interface ContextHistory {
    readonly entries: readonly AgentSessionEntry[];
    readonly messages: AgentMessage[];
    readonly closedBoundaries: ReadonlySet<number>;
    readonly protectedIndex: number;
    readonly compactedCount: number;
    readonly previousSummary?: ContextSummary;
}
export declare function loadContextHistory(entries: readonly AgentSessionEntry[]): ContextHistory;
/** Durable checkpoints fence prefix cuts in entry space, not filtered message space. */
export declare function chooseContextCut(history: ContextHistory, checkpoints: readonly AgentCheckpoint[], sessionId: string): number;
//# sourceMappingURL=context-history.d.ts.map