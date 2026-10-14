import type { RuntimeLedger } from "../runtime/ledger";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { AgentSessionStore } from "../store/session-store";
export { exportLegacyIndexedDBBackup, restoreLegacyIndexedDBBackup } from "./indexeddb-database";
export type { IndexedDBLegacyBackupRow } from "./indexeddb-database";
export { AGENT_STORE_SCHEMA_VERSION } from "../store/schema-migration";
export interface CreateIndexedDBStoresOptions {
    name?: string;
    indexedDB?: IDBFactory;
}
export interface IndexedDBStores {
    sessionStore: AgentSessionStore;
    artifactStore: AgentArtifactStore;
    ledger: RuntimeLedger;
    close(): void;
}
/** Durable stores with commit-before-resolution and no volatile fallback. */
export declare function createIndexedDBStores(options?: CreateIndexedDBStoresOptions): Promise<IndexedDBStores>;
//# sourceMappingURL=indexeddb.d.ts.map