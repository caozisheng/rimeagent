import { AGENT_STORE_SCHEMA_VERSION, convertLegacySession } from "../store/schema-migration";
import { isRecord, isId, isCount } from "../store/validation";

type StoreName = "sessions" | "entries" | "checkpoints" | "artifactSessions" | "artifacts" | "runs" | "ledger" | "claims" | "legacyBackup";
export interface IndexedDBLegacyBackupRow {
	readonly store: Exclude<StoreName, "legacyBackup">;
	readonly key: IDBValidKey;
	readonly value: unknown;
}


interface StoreDefinition {
	keyPath: string | string[];
	indexes?: { name: string; keyPath: string | string[]; unique?: boolean }[];
}

const STORES: Record<StoreName, StoreDefinition> = {
	sessions: { keyPath: "sessionId" },
	entries: { keyPath: ["sessionId", "id"], indexes: [{ name: "session", keyPath: "sessionId" }, { name: "order", keyPath: ["sessionId", "position"], unique: true }] },
	checkpoints: { keyPath: "checkpointId", indexes: [{ name: "session", keyPath: "sessionId" }, { name: "order", keyPath: ["sessionId", "position"], unique: true }] },
	artifactSessions: { keyPath: "sessionId" },
	artifacts: { keyPath: "artifactId", indexes: [{ name: "session", keyPath: "sessionId" }, { name: "order", keyPath: ["sessionId", "position"], unique: true }] },
	runs: { keyPath: "runId" },
	ledger: { keyPath: ["runId", "seq"], indexes: [{ name: "run", keyPath: "runId" }] },
	claims: { keyPath: "toolCallId" },
	legacyBackup: { keyPath: ["store", "key"] },
};

/** Requests are the only asynchronous work allowed inside an adapter transaction. */
export function request<T>(operation: IDBRequest<T>): Promise<T> {
	const deferred = Promise.withResolvers<T>();
	operation.onsuccess = () => deferred.resolve(operation.result);
	operation.onerror = () => deferred.reject(operation.error ?? new Error("IndexedDB request failed"));
	return deferred.promise;
}

export class IndexedDBHandle {
	private closed = false;

	constructor(private readonly database: IDBDatabase) {
		database.onversionchange = () => this.close();
		database.onclose = () => { this.closed = true; };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.database.close();
	}

	async transaction<T>(stores: StoreName[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T> | T): Promise<T> {
		if (this.closed) throw new Error("IndexedDB stores are closed");
		const transaction = this.database.transaction(stores, mode);
		const deferred = Promise.withResolvers<T>();
		let result: T;
		let failure: unknown;
		transaction.oncomplete = () => deferred.resolve(result);
		transaction.onabort = () => deferred.reject(failure ?? transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => { failure ??= transaction.error; };
		try {
			Promise.resolve(operation(transaction)).then(value => { result = value; }, error => {
				failure = error;
				try { transaction.abort(); } catch { deferred.reject(error); }
			});
		} catch (error) {
			failure = error;
			try { transaction.abort(); } catch { deferred.reject(error); }
		}
		return deferred.promise;
	}
}

function verifySchema(database: IDBDatabase, upgrading?: IDBTransaction): void {
	const names = Object.keys(STORES) as StoreName[];
	if (database.objectStoreNames.length !== names.length || names.some(name => !database.objectStoreNames.contains(name))) {
		throw new Error("Unsupported IndexedDB store schema");
	}
	const transaction = upgrading ?? database.transaction(names, "readonly");
	for (const name of names) {
		const definition = STORES[name];
		const store = transaction.objectStore(name);
		if (JSON.stringify(store.keyPath) !== JSON.stringify(definition.keyPath) || store.autoIncrement
			|| store.indexNames.length !== (definition.indexes?.length ?? 0)) throw new Error("Unsupported IndexedDB store schema");
		for (const expected of definition.indexes ?? []) {
			if (!store.indexNames.contains(expected.name)) throw new Error("Unsupported IndexedDB index schema");
			const index = store.index(expected.name);
			if (JSON.stringify(index.keyPath) !== JSON.stringify(expected.keyPath) || index.unique !== (expected.unique ?? false) || index.multiEntry) {
				throw new Error("Unsupported IndexedDB index schema");
			}
		}
	}
}

type LegacyRows = { store: StoreName; keys: IDBValidKey[]; values: unknown[] };

/** All reads are queued in the upgrade task; conversion and writes run in the last request event. */
function migrateVersionOne(transaction: IDBTransaction, fail: (error: unknown) => void): void {
	const names = (Object.keys(STORES) as StoreName[]).filter(name => name !== "legacyBackup");
	const rows = new Map<StoreName, LegacyRows>();
	let pending = names.length * 2;
	for (const store of names) {
		const source = transaction.objectStore(store);
		const keysRequest = source.getAllKeys();
		const valuesRequest = source.getAll();
		const row: LegacyRows = { store, keys: [], values: [] };
		rows.set(store, row);
		keysRequest.onsuccess = () => {
			row.keys = keysRequest.result;
			if (--pending === 0) finish();
		};
		valuesRequest.onsuccess = () => {
			row.values = valuesRequest.result;
			if (--pending === 0) finish();
		};
	}
	function finish(): void {
		try {
			const complete = names.map(name => rows.get(name)!);
			if (complete.some(row => row.keys.length !== row.values.length)) throw new TypeError("Incomplete legacy database backup");
			convertVersionOneRows(transaction, complete);
		} catch (error) { fail(error); }
	}
}

function convertVersionOneRows(transaction: IDBTransaction, rows: LegacyRows[]): void {
	const data = new Map(rows.map(row => [row.store, row.values]));
	const backup = transaction.objectStore("legacyBackup");
	for (const row of rows) for (let index = 0; index < row.values.length; index++) {
		backup.add({ store: row.store, key: row.keys[index], value: row.values[index] });
	}
	const sessions = data.get("sessions") ?? [];
	const entryRows = data.get("entries") ?? [];
	const checkpointRows = data.get("checkpoints") ?? [];
	const artifactRows = data.get("artifacts") ?? [];
	const ledgerRows = data.get("ledger") ?? [];
	const runOwners = new Map<string, string>();
	for (const row of entryRows) {
		if (!isRecord(row) || !isId(row.sessionId) || !isId(row.id) || !isCount(row.position) || typeof row.json !== "string") throw new TypeError("Invalid legacy entry row");
		const entry: unknown = JSON.parse(row.json);
		if (isRecord(entry) && entry.kind === "run_started" && isId(entry.runId)) {
			if (runOwners.has(entry.runId)) throw new TypeError("Duplicate legacy run ID");
			runOwners.set(entry.runId, row.sessionId);
		}
	}
	const ledgerIndex = new Map<string, Record<string, unknown>>();
	for (const row of ledgerRows) {
		if (!isRecord(row) || !isId(row.runId) || !runOwners.has(row.runId) || !isCount(row.seq) || row.seq === 0) throw new TypeError("Orphan legacy ledger run");
		const key = `${row.runId}:${row.seq}`;
		if (ledgerIndex.has(key)) throw new TypeError("Duplicate legacy ledger sequence");
		ledgerIndex.set(key, row);
	}
	for (const row of data.get("runs") ?? []) {
		if (!isRecord(row) || !isId(row.runId) || !isCount(row.seq) || !runOwners.has(row.runId)
			|| row.seq !== Math.max(0, ...ledgerRows.filter(item => isRecord(item) && item.runId === row.runId).map(item => (item as Record<string, unknown>).seq as number))) throw new TypeError("Invalid legacy run index");
	}
	for (const row of data.get("claims") ?? []) {
		if (!isRecord(row) || !isId(row.toolCallId) || !Object.keys(row).every(key => ["toolCallId", "intent", "latest", "successful"].includes(key))) throw new TypeError("Invalid legacy tool claim");
		for (const key of ["intent", "latest", "successful"] as const) {
			if (row[key] === undefined) continue;
			const index = row[key];
			if (!Array.isArray(index) || index.length !== 2 || !isId(index[0]) || !isCount(index[1])) throw new TypeError("Invalid legacy tool claim key");
			const linked = ledgerIndex.get(`${index[0]}:${index[1]}`);
			if (!linked || !isRecord(linked.event) || linked.event.toolCallId !== row.toolCallId
				|| key === "intent" && linked.event.kind !== "tool_intent"
				|| key === "successful" && (linked.event.kind !== "tool_exec" || linked.event.outcome !== "success")
				|| key === "latest" && linked.event.kind !== "tool_exec" && linked.event.kind !== "tool_intent") throw new TypeError("Mismatched legacy tool claim index");
		}
	}
	const allSessions = new Set<string>();
	for (const session of sessions) {
		if (!isRecord(session) || !isId(session.sessionId) || !isCount(session.entryCount) || !isCount(session.checkpointCount)
			|| allSessions.has(session.sessionId)) throw new TypeError("Invalid legacy session metadata");
		const sessionId = session.sessionId;
		allSessions.add(sessionId);
		const entries = entryRows.filter(row => isRecord(row) && row.sessionId === sessionId);
		const checkpoints = checkpointRows.filter(row => isRecord(row) && row.sessionId === sessionId);
		const artifacts = artifactRows.filter(row => isRecord(row) && row.sessionId === sessionId);
		const ledger = ledgerRows.filter(row => isRecord(row) && isId(row.runId) && runOwners.get(row.runId) === sessionId);
		if (session.entryCount !== entries.length || session.checkpointCount !== checkpoints.length) throw new TypeError("Legacy session row count mismatch");
		for (const row of checkpoints) if (!isRecord(row) || !isCount(row.position) || !isId(row.checkpointId)) throw new TypeError("Invalid legacy checkpoint row");
		for (const row of artifacts) if (!isRecord(row) || !isCount(row.position) || !isId(row.artifactId)) throw new TypeError("Invalid legacy artifact row");
		entries.sort((left, right) => ((left as Record<string, unknown>).position as number) - ((right as Record<string, unknown>).position as number));
		checkpoints.sort((left, right) => ((left as Record<string, unknown>).position as number) - ((right as Record<string, unknown>).position as number));
		for (let index = 0; index < entries.length; index++) if ((entries[index] as Record<string, unknown>).position !== index) throw new TypeError("Noncontiguous legacy entry order");
		for (let index = 0; index < checkpoints.length; index++) if ((checkpoints[index] as Record<string, unknown>).position !== index) throw new TypeError("Noncontiguous legacy checkpoint order");
		const converted = convertLegacySession({ sessionId,
			entries: entries.map(row => JSON.parse((row as Record<string, unknown>).json as string)),
			checkpoints: checkpoints.map(row => (row as Record<string, unknown>).value),
			artifacts: artifacts.map(row => (row as Record<string, unknown>).value), ledger });
		for (let index = 0; index < entries.length; index++) transaction.objectStore("entries").put({ ...(entries[index] as object), json: JSON.stringify(converted.entries[index]) });
		for (let index = 0; index < checkpoints.length; index++) transaction.objectStore("checkpoints").put({ ...(checkpoints[index] as object), value: converted.checkpoints[index] });
		for (let index = 0; index < ledger.length; index++) transaction.objectStore("ledger").put(converted.ledger[index]);
	}
	if (entryRows.some(row => !isRecord(row) || !isId(row.sessionId) || !allSessions.has(row.sessionId))
		|| checkpointRows.some(row => !isRecord(row) || !isId(row.sessionId) || !allSessions.has(row.sessionId))) throw new TypeError("Orphan legacy history row");
	if (artifactRows.some(row => !isRecord(row) || !isId(row.sessionId) || !allSessions.has(row.sessionId) || !isId(row.artifactId))) throw new TypeError("Invalid legacy artifact row");
	for (const row of data.get("artifactSessions") ?? []) if (!isRecord(row) || !isId(row.sessionId) || !allSessions.has(row.sessionId) || !isCount(row.count)
		|| (artifactRows.filter(item => isRecord(item) && item.sessionId === row.sessionId).length !== row.count)) throw new TypeError("Legacy artifact count mismatch");
}

export async function openDatabase(factory: IDBFactory, name: string): Promise<IndexedDBHandle> {
	const deferred = Promise.withResolvers<IndexedDBHandle>();
	const opening = factory.open(name, AGENT_STORE_SCHEMA_VERSION);
	let rejected = false;
	let migrationError: unknown;
	opening.onblocked = () => {
		rejected = true;
		deferred.reject(new Error("IndexedDB database opening is blocked"));
	};
	opening.onupgradeneeded = event => {
		if (rejected) { opening.transaction!.abort(); return; }
		const transaction = opening.transaction!;
		try {
			if (event.oldVersion === 0) {
				for (const storeName of Object.keys(STORES) as StoreName[]) {
					const definition = STORES[storeName];
					const store = opening.result.createObjectStore(storeName, { keyPath: definition.keyPath });
					for (const index of definition.indexes ?? []) store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
				}
			} else if (event.oldVersion === 1) {
				if (opening.result.objectStoreNames.length !== Object.keys(STORES).length - 1 || opening.result.objectStoreNames.contains("legacyBackup")) throw new Error("Unsupported legacy IndexedDB schema");
				opening.result.createObjectStore("legacyBackup", { keyPath: ["store", "key"] });
				verifySchema(opening.result, transaction);
				migrateVersionOne(transaction, error => { migrationError = error; transaction.abort(); });
			} else throw new Error("Unsupported IndexedDB migration version");
		} catch (error) {
			migrationError = error;
			transaction.abort();
		}
	};
	opening.onerror = () => deferred.reject(migrationError ?? opening.error ?? new Error("IndexedDB database opening failed"));
	opening.onsuccess = () => {
		if (rejected) { opening.result.close(); return; }
		try {
			verifySchema(opening.result);
			deferred.resolve(new IndexedDBHandle(opening.result));
		} catch (error) {
			opening.result.close();
			deferred.reject(error);
		}
	};
	return deferred.promise;
}

/** Exports the complete pre-upgrade version-one database image for offline recovery. */
export async function exportLegacyIndexedDBBackup(factory: IDBFactory, name: string): Promise<IndexedDBLegacyBackupRow[]> {
	const handle = await openDatabase(factory, name);
	try {
		return await handle.transaction(["legacyBackup"], "readonly", async transaction => {
			const records: unknown[] = await request(transaction.objectStore("legacyBackup").getAll());
			for (const row of records) if (!isRecord(row) || !isId(row.store) || row.store === "legacyBackup" || !Object.hasOwn(STORES, row.store)
				|| !Object.hasOwn(row, "key") || !Object.hasOwn(row, "value")) throw new TypeError("Corrupt original database backup");
			if (records.length === 0) throw new Error("No pre-upgrade IndexedDB backup exists");
			return records as IndexedDBLegacyBackupRow[];
		});
	} finally { handle.close(); }
}

/** Restores original rows to a NEW version-one database; never downgrades the migrated database in place. */
export async function restoreLegacyIndexedDBBackup(factory: IDBFactory, migratedName: string, targetName: string): Promise<void> {
	if (!isId(targetName) || targetName === migratedName) throw new TypeError("Restore target must be a distinct nonempty database name");
	const backup = await exportLegacyIndexedDBBackup(factory, migratedName);
	const deferred = Promise.withResolvers<void>();
	const opening = factory.open(targetName, 1);
	let failure: unknown;
	let created = false;
	opening.onblocked = () => deferred.reject(new Error("Legacy restore is blocked"));
	opening.onupgradeneeded = event => {
		const tx = opening.transaction!;
		try {
			if (event.oldVersion !== 0) throw new Error("Legacy restore target already exists");
			created = true;
			for (const name of Object.keys(STORES) as StoreName[]) {
				if (name === "legacyBackup") continue;
				const definition = STORES[name];
				const store = opening.result.createObjectStore(name, { keyPath: definition.keyPath });
				for (const index of definition.indexes ?? []) store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
			}
			for (const row of backup) tx.objectStore(row.store).add(row.value);
		} catch (error) { failure = error; tx.abort(); }
	};
	opening.onerror = () => deferred.reject(failure ?? opening.error ?? new Error("Legacy restore aborted"));
	opening.onsuccess = () => { opening.result.close(); if (created) deferred.resolve(); else deferred.reject(new Error("Legacy restore target already exists")); };
	await deferred.promise;
}
