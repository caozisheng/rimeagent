type StoreName = "sessions" | "entries" | "checkpoints" | "artifactSessions" | "artifacts" | "runs" | "ledger" | "claims" | "legacyBackup";
export interface IndexedDBLegacyBackupRow {
    readonly store: Exclude<StoreName, "legacyBackup">;
    readonly key: IDBValidKey;
    readonly value: unknown;
}
/** Requests are the only asynchronous work allowed inside an adapter transaction. */
export declare function request<T>(operation: IDBRequest<T>): Promise<T>;
export declare class IndexedDBHandle {
    private readonly database;
    private closed;
    constructor(database: IDBDatabase);
    close(): void;
    transaction<T>(stores: StoreName[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T> | T): Promise<T>;
}
export declare function openDatabase(factory: IDBFactory, name: string): Promise<IndexedDBHandle>;
/** Exports the complete pre-upgrade version-one database image for offline recovery. */
export declare function exportLegacyIndexedDBBackup(factory: IDBFactory, name: string): Promise<IndexedDBLegacyBackupRow[]>;
/** Restores original rows to a NEW version-one database; never downgrades the migrated database in place. */
export declare function restoreLegacyIndexedDBBackup(factory: IDBFactory, migratedName: string, targetName: string): Promise<void>;
export {};
//# sourceMappingURL=indexeddb-database.d.ts.map