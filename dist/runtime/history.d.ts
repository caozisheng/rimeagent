import type { AgentMessage } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentCheckpoint, AgentCheckpointRef } from "../store/checkpoint";
import type { ProjectFactsDigest } from "./context-manager";
type EntryBody = AgentSessionEntry extends infer E ? E extends AgentSessionEntry ? Omit<E, "id" | "ts"> : never : never;
export declare function projectMessages(entries: readonly AgentSessionEntry[]): AgentMessage[];
/** New runs require a complete protocol; resume repairs the final pending batch. */
export declare function assertCompleteHistory(messages: readonly AgentMessage[]): void;
export interface HistoryBoundary {
    runId: string;
    seq: number;
    projectFacts?: ProjectFactsDigest;
}
/** Appends confirmed messages only; lifecycle/checkpoints never enter the model projection. */
export declare class RuntimeHistory {
    private readonly store;
    readonly sessionId: string;
    private parentId;
    persistenceFailures: number;
    constructor(store: AgentSessionStore, sessionId: string);
    private access;
    append(body: EntryBody): Promise<void>;
    recordMessage(message: AgentMessage, artifactId?: string): Promise<void>;
    entries(): Promise<AgentSessionEntry[]>;
    checkpoints(): Promise<AgentCheckpoint[]>;
    load(initialMessages?: readonly AgentMessage[]): Promise<AgentMessage[]>;
    checkpoint(label?: string, boundary?: HistoryBoundary): Promise<AgentCheckpointRef>;
}
export {};
//# sourceMappingURL=history.d.ts.map