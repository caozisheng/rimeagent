import type { AgentArtifact, AgentArtifactStore } from "../store/artifact-store";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentMessage } from "../types";
export interface PreparedContextMessages {
    readonly messages: AgentMessage[];
    readonly artifacts: AgentArtifact[];
}
export interface ContextToolProjectionOptions {
    readonly sessionId: string;
    readonly artifactStore: AgentArtifactStore;
    readonly maxTokens: number;
    readonly countTokens: (text: string) => number;
    readonly signal?: AbortSignal;
}
/** Prepare without writes so invalid summaries and cancelled hooks cannot leave artifacts. */
export declare function prepareContextMessages(entries: readonly AgentSessionEntry[], options: ContextToolProjectionOptions): Promise<PreparedContextMessages>;
//# sourceMappingURL=context-tools.d.ts.map