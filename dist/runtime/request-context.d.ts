import type { AgentRuntimeConfig } from "./runtime";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { NormalizedError } from "../errors";
import type { LedgerRecord } from "./ledger";
import type { IterationRequestInput, PreparedIterationRequest } from "./iteration";
export interface RequestContextOptions {
    config: AgentRuntimeConfig;
    artifactStore: AgentArtifactStore;
    signal: AbortSignal;
    assertBoundary: () => Promise<void>;
    recordLedger: (event: LedgerRecord["event"]) => Promise<void>;
    onPersistenceFailure: () => void;
    hasPersistenceFailure: () => boolean;
}
export interface RuntimeRequestContext {
    prepare(input: IterationRequestInput): Promise<PreparedIterationRequest>;
    guardPreparationError(cause: unknown): void;
    recover(error: NormalizedError, attempt: number): Promise<boolean>;
}
export declare function createRuntimeRequestContext(options: RequestContextOptions): RuntimeRequestContext;
//# sourceMappingURL=request-context.d.ts.map