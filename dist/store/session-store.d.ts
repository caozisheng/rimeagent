import type { AgentCheckpoint } from "./checkpoint";
import type { AgentSessionEntry, AgentSessionSnapshot } from "./entries";
export interface AgentSessionStore {
    load(sessionId: string): Promise<AgentSessionSnapshot | null>;
    append(sessionId: string, entry: AgentSessionEntry): Promise<void>;
    saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
    listCheckpoints(sessionId: string): Promise<AgentCheckpoint[]>;
}
export declare function isCheckpoint(value: unknown): value is AgentCheckpoint;
/** Append-only isolated history; checkpoint references do not restore projects. */
export declare class InMemorySessionStore implements AgentSessionStore {
    private readonly sessions;
    private readonly checkpoints;
    load(sessionId: string): Promise<AgentSessionSnapshot | null>;
    append(sessionId: string, entry: AgentSessionEntry): Promise<void>;
    saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
    listCheckpoints(sessionId: string): Promise<AgentCheckpoint[]>;
}
//# sourceMappingURL=session-store.d.ts.map