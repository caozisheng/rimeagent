import type { RuntimeLedger } from "../runtime/ledger";
import type { AgentArtifact, AgentArtifactStore } from "../store/artifact-store";
import type { AgentCheckpoint } from "../store/checkpoint";
import type { AgentSessionEntry, AgentSessionSnapshot } from "../store/entries";
import type { AgentSessionStore } from "../store/session-store";
import type { IndexedDBHandle } from "./indexeddb-database";
import { isArtifact } from "../store/artifact-store";
import { parseAgentSessionEntry, serializeAgentSessionEntry } from "../store/entries";
import { cloneJson } from "../store/json";
import { isCheckpoint } from "../store/session-store";
import { isId } from "../store/validation";
import { openDatabase, request } from "./indexeddb-database";
import { IndexedDBLedger } from "./indexeddb-ledger";

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

interface SessionMetadata { sessionId: string; entryCount: number; checkpointCount: number }
interface EntryRecord { sessionId: string; id: string; position: number; json: string }
interface CheckpointRecord { checkpointId: string; sessionId: string; position: number; value: AgentCheckpoint }
interface ArtifactMetadata { sessionId: string; count: number }
interface ArtifactRecord { artifactId: string; sessionId: string; position: number; value: AgentArtifact }

class IndexedDBSessionStore implements AgentSessionStore {
	constructor(private readonly handle: IndexedDBHandle) {}

	async load(sessionId: string): Promise<AgentSessionSnapshot | null> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		return this.handle.transaction(["sessions", "entries"], "readonly", async transaction => {
			const metadata: SessionMetadata | undefined = await request(transaction.objectStore("sessions").get(sessionId));
			if (!metadata) return null;
			const records: EntryRecord[] = await request(transaction.objectStore("entries").index("session").getAll(sessionId));
			records.sort((left, right) => left.position - right.position);
			return { sessionId, entries: records.map(record => parseAgentSessionEntry(record.json)) };
		});
	}

	async append(sessionId: string, entry: AgentSessionEntry): Promise<void> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		const json = serializeAgentSessionEntry(entry);
		const snapshot = parseAgentSessionEntry(json);
		await this.handle.transaction(["sessions", "entries"], "readwrite", async transaction => {
			const sessions = transaction.objectStore("sessions");
			const metadata: SessionMetadata = await request(sessions.get(sessionId)) ?? { sessionId, entryCount: 0, checkpointCount: 0 };
			const value: EntryRecord = { sessionId, id: snapshot.id, position: metadata.entryCount, json };
			metadata.entryCount++;
			await request(sessions.put(metadata));
			await request(transaction.objectStore("entries").add(value));
		});
	}

	async saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void> {
		if (!isCheckpoint(checkpoint)) throw new TypeError("Invalid agent checkpoint");
		const snapshot = cloneJson(checkpoint);
		if (!isCheckpoint(snapshot)) throw new TypeError("Invalid normalized agent checkpoint");
		await this.handle.transaction(["sessions", "checkpoints"], "readwrite", async transaction => {
			const sessions = transaction.objectStore("sessions");
			const checkpoints = transaction.objectStore("checkpoints");
			let metadata: SessionMetadata | undefined = await request(sessions.get(snapshot.sessionId));
			if (!metadata && (snapshot.entrySeq !== 0 || snapshot.parentId !== undefined)) throw new Error("Checkpoint requires an existing session");
			if (snapshot.entrySeq > (metadata?.entryCount ?? 0)) throw new Error("Checkpoint exceeds session boundary");
			if (snapshot.parentId !== undefined) {
				const parent: CheckpointRecord | undefined = await request(checkpoints.get(snapshot.parentId));
				if (!parent) throw new Error("Checkpoint parent does not exist");
				if (parent.sessionId !== snapshot.sessionId) throw new Error("Checkpoint parent belongs to another session");
				if (parent.value.entrySeq > snapshot.entrySeq) throw new Error("Checkpoint precedes its parent boundary");
			}
			metadata ??= { sessionId: snapshot.sessionId, entryCount: 0, checkpointCount: 0 };
			const value: CheckpointRecord = { checkpointId: snapshot.checkpointId, sessionId: snapshot.sessionId, position: metadata.checkpointCount, value: snapshot };
			metadata.checkpointCount++;
			await request(sessions.put(metadata));
			await request(checkpoints.add(value));
		});
	}

	async listCheckpoints(sessionId: string): Promise<AgentCheckpoint[]> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		return this.handle.transaction(["checkpoints"], "readonly", async transaction => {
			const records: CheckpointRecord[] = await request(transaction.objectStore("checkpoints").index("session").getAll(sessionId));
			records.sort((left, right) => left.position - right.position);
			return records.map(record => {
				if (!isCheckpoint(record.value)) throw new TypeError("Invalid persisted agent checkpoint");
				return cloneJson(record.value);
			});
		});
	}
}

class IndexedDBArtifactStore implements AgentArtifactStore {
	constructor(private readonly handle: IndexedDBHandle) {}

	async put(artifact: AgentArtifact): Promise<void> {
		if (!isArtifact(artifact)) throw new TypeError("Invalid JSON artifact");
		const snapshot = cloneJson(artifact);
		if (!isArtifact(snapshot)) throw new TypeError("Invalid normalized JSON artifact");
		await this.handle.transaction(["artifactSessions", "artifacts"], "readwrite", async transaction => {
			const sessions = transaction.objectStore("artifactSessions");
			const metadata: ArtifactMetadata = await request(sessions.get(snapshot.sessionId)) ?? { sessionId: snapshot.sessionId, count: 0 };
			const value: ArtifactRecord = { artifactId: snapshot.artifactId, sessionId: snapshot.sessionId, position: metadata.count, value: snapshot };
			metadata.count++;
			await request(sessions.put(metadata));
			await request(transaction.objectStore("artifacts").add(value));
		});
	}

	async get(artifactId: string): Promise<AgentArtifact | null> {
		if (!isId(artifactId)) throw new TypeError("Invalid artifact id");
		return this.handle.transaction(["artifacts"], "readonly", async transaction => {
			const record: ArtifactRecord | undefined = await request(transaction.objectStore("artifacts").get(artifactId));
			if (!record) return null;
			if (!isArtifact(record.value)) throw new TypeError("Invalid persisted JSON artifact");
			return cloneJson(record.value);
		});
	}

	async list(sessionId: string): Promise<AgentArtifact[]> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		return this.handle.transaction(["artifacts"], "readonly", async transaction => {
			const records: ArtifactRecord[] = await request(transaction.objectStore("artifacts").index("session").getAll(sessionId));
			records.sort((left, right) => left.position - right.position);
			return records.map(record => {
				if (!isArtifact(record.value)) throw new TypeError("Invalid persisted JSON artifact");
				return cloneJson(record.value);
			});
		});
	}
}

/** Durable stores with commit-before-resolution and no volatile fallback. */
export async function createIndexedDBStores(options: CreateIndexedDBStoresOptions = {}): Promise<IndexedDBStores> {
	const name = options.name ?? "rimeagent";
	if (!isId(name)) throw new TypeError("Invalid IndexedDB database name");
	const factory = options.indexedDB ?? globalThis.indexedDB;
	if (!factory) throw new Error("IndexedDB is unavailable");
	const handle = await openDatabase(factory, name);
	return {
		sessionStore: new IndexedDBSessionStore(handle), artifactStore: new IndexedDBArtifactStore(handle),
		ledger: new IndexedDBLedger(handle), close: () => handle.close(),
	};
}
