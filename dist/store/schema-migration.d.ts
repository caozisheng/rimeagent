import type { AgentCheckpoint } from "./checkpoint";
import type { AgentSessionEntry } from "./entries";
import type { LedgerRecord } from "../runtime/ledger";
import type { ExternalStateBinding } from "../tool-types";
export declare const AGENT_STORE_SCHEMA_VERSION: 2;
/** Converts only validated legacy durable fields; never reads result.data as metadata. */
export declare function convertLegacyCheckpoint(value: unknown): AgentCheckpoint;
export declare function convertLegacyEntry(value: unknown): AgentSessionEntry;
export declare function convertLegacyLedger(value: unknown, binding?: ExternalStateBinding): LedgerRecord;
export interface LegacySessionGroup {
    readonly sessionId: string;
    readonly entries: readonly unknown[];
    readonly checkpoints: readonly unknown[];
    readonly artifacts: readonly unknown[];
    readonly ledger: readonly unknown[];
}
/** Pure, fail-closed conversion for the complete session's references and digests. */
export declare function convertLegacySession(group: LegacySessionGroup): {
    entries: AgentSessionEntry[];
    checkpoints: AgentCheckpoint[];
    ledger: LedgerRecord[];
};
//# sourceMappingURL=schema-migration.d.ts.map