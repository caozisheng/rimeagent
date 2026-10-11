import type { AgentMessage } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentCheckpointRef } from "../store/checkpoint";
type EntryBody = AgentSessionEntry extends infer E ? E extends AgentSessionEntry ? Omit<E, "id" | "ts"> : never : never;
/** This stage cannot resume an interrupted tool batch; never send a broken tool protocol. */
export declare function assertCompleteHistory(messages: readonly AgentMessage[]): void;
/** Appends confirmed messages only; lifecycle/checkpoints never enter the model projection. */
export declare class RuntimeHistory {
    private readonly store;
    readonly sessionId: string;
    private parentId;
    persistenceFailures: number;
    constructor(store: AgentSessionStore, sessionId: string);
    private access;
    append(body: EntryBody): Promise<void>;
    recordMessage(message: AgentMessage): Promise<void>;
    load(initialMessages?: readonly AgentMessage[]): Promise<AgentMessage[]>;
    checkpoint(label?: string): Promise<AgentCheckpointRef>;
}
export {};
//# sourceMappingURL=history.d.ts.map