type StoreName = "sessions" | "entries" | "checkpoints" | "artifactSessions" | "artifacts" | "runs" | "ledger" | "claims";
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
export {};
//# sourceMappingURL=indexeddb-database.d.ts.map