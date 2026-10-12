const STORES = {
    sessions: { keyPath: "sessionId" },
    entries: { keyPath: ["sessionId", "id"], indexes: [{ name: "session", keyPath: "sessionId" }, { name: "order", keyPath: ["sessionId", "position"], unique: true }] },
    checkpoints: { keyPath: "checkpointId", indexes: [{ name: "session", keyPath: "sessionId" }, { name: "order", keyPath: ["sessionId", "position"], unique: true }] },
    artifactSessions: { keyPath: "sessionId" },
    artifacts: { keyPath: "artifactId", indexes: [{ name: "session", keyPath: "sessionId" }, { name: "order", keyPath: ["sessionId", "position"], unique: true }] },
    runs: { keyPath: "runId" },
    ledger: { keyPath: ["runId", "seq"], indexes: [{ name: "run", keyPath: "runId" }] },
    claims: { keyPath: "toolCallId" },
};
/** Requests are the only asynchronous work allowed inside an adapter transaction. */
export function request(operation) {
    const deferred = Promise.withResolvers();
    operation.onsuccess = () => deferred.resolve(operation.result);
    operation.onerror = () => deferred.reject(operation.error ?? new Error("IndexedDB request failed"));
    return deferred.promise;
}
export class IndexedDBHandle {
    database;
    closed = false;
    constructor(database) {
        this.database = database;
        database.onversionchange = () => this.close();
        database.onclose = () => { this.closed = true; };
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.database.close();
    }
    async transaction(stores, mode, operation) {
        if (this.closed)
            throw new Error("IndexedDB stores are closed");
        const transaction = this.database.transaction(stores, mode);
        const deferred = Promise.withResolvers();
        let result;
        let failure;
        transaction.oncomplete = () => deferred.resolve(result);
        transaction.onabort = () => deferred.reject(failure ?? transaction.error ?? new Error("IndexedDB transaction aborted"));
        transaction.onerror = () => { failure ??= transaction.error; };
        try {
            Promise.resolve(operation(transaction)).then(value => { result = value; }, error => {
                failure = error;
                try {
                    transaction.abort();
                }
                catch {
                    deferred.reject(error);
                }
            });
        }
        catch (error) {
            failure = error;
            try {
                transaction.abort();
            }
            catch {
                deferred.reject(error);
            }
        }
        return deferred.promise;
    }
}
function verifySchema(database) {
    const names = Object.keys(STORES);
    if (database.objectStoreNames.length !== names.length || names.some(name => !database.objectStoreNames.contains(name))) {
        throw new Error("Unsupported IndexedDB store schema");
    }
    const transaction = database.transaction(names, "readonly");
    for (const name of names) {
        const definition = STORES[name];
        const store = transaction.objectStore(name);
        if (JSON.stringify(store.keyPath) !== JSON.stringify(definition.keyPath) || store.autoIncrement
            || store.indexNames.length !== (definition.indexes?.length ?? 0))
            throw new Error("Unsupported IndexedDB store schema");
        for (const expected of definition.indexes ?? []) {
            if (!store.indexNames.contains(expected.name))
                throw new Error("Unsupported IndexedDB index schema");
            const index = store.index(expected.name);
            if (JSON.stringify(index.keyPath) !== JSON.stringify(expected.keyPath) || index.unique !== (expected.unique ?? false) || index.multiEntry) {
                throw new Error("Unsupported IndexedDB index schema");
            }
        }
    }
}
export async function openDatabase(factory, name) {
    const deferred = Promise.withResolvers();
    const opening = factory.open(name, 1);
    let rejected = false;
    let migrationError;
    opening.onblocked = () => {
        rejected = true;
        deferred.reject(new Error("IndexedDB database opening is blocked"));
    };
    opening.onupgradeneeded = () => {
        if (rejected) {
            opening.transaction.abort();
            return;
        }
        try {
            for (const name of Object.keys(STORES)) {
                const definition = STORES[name];
                const store = opening.result.createObjectStore(name, { keyPath: definition.keyPath });
                for (const index of definition.indexes ?? [])
                    store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
            }
        }
        catch (error) {
            migrationError = error;
            opening.transaction.abort();
        }
    };
    opening.onerror = () => deferred.reject(migrationError ?? opening.error ?? new Error("IndexedDB database opening failed"));
    opening.onsuccess = () => {
        if (rejected) {
            opening.result.close();
            return;
        }
        try {
            verifySchema(opening.result);
            deferred.resolve(new IndexedDBHandle(opening.result));
        }
        catch (error) {
            opening.result.close();
            deferred.reject(error);
        }
    };
    return deferred.promise;
}
//# sourceMappingURL=indexeddb-database.js.map