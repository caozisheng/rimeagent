import type { JsonValue } from "./json";
export interface AgentArtifact {
    readonly artifactId: string;
    readonly sessionId: string;
    readonly contentType: string;
    readonly value: JsonValue;
}
export interface AgentArtifactStore {
    put(record: AgentArtifact): Promise<void>;
    get(artifactId: string): Promise<AgentArtifact | null>;
    list(sessionId: string): Promise<AgentArtifact[]>;
}
/** Immutable JSON artifact storage. Media bytes belong to the host, not this store. */
export declare class InMemoryArtifactStore implements AgentArtifactStore {
    private readonly artifacts;
    private readonly sessions;
    put(record: AgentArtifact): Promise<void>;
    get(artifactId: string): Promise<AgentArtifact | null>;
    list(sessionId: string): Promise<AgentArtifact[]>;
}
//# sourceMappingURL=artifact-store.d.ts.map