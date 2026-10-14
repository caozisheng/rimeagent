import type { AgentCheckpoint } from "./checkpoint";
import type { AgentSessionEntry, AgentSessionSnapshot } from "./entries";
import { parseAgentSessionEntry, serializeAgentSessionEntry } from "./entries";
import { cloneJson } from "./json";
import { hasOnlyKeys, isCount, isExternalStateBinding, isId, isRecord } from "./validation";

export interface AgentSessionStore {
	load(sessionId: string): Promise<AgentSessionSnapshot | null>;
	append(sessionId: string, entry: AgentSessionEntry): Promise<void>;
	saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
	listCheckpoints(sessionId: string): Promise<AgentCheckpoint[]>;
}

interface StoredSession {
	entries: AgentSessionEntry[];
	entryIds: Set<string>;
	checkpoints: AgentCheckpoint[];
}

const CHECKPOINT_KEYS = ["checkpointId", "sessionId", "parentId", "createdAt", "entrySeq", "contextDigest", "label", "runId", "seq", "externalStateBinding"];
const REQUIRED_CHECKPOINT_KEYS = ["checkpointId", "sessionId", "createdAt", "entrySeq", "contextDigest"];

export function isCheckpoint(value: unknown): value is AgentCheckpoint {
	return isRecord(value) && hasOnlyKeys(value, CHECKPOINT_KEYS)
		&& REQUIRED_CHECKPOINT_KEYS.every(key => Object.hasOwn(value, key))
		&& isId(value.checkpointId) && isId(value.sessionId) && isId(value.contextDigest)
		&& (!Object.hasOwn(value, "parentId") || value.parentId === undefined || isId(value.parentId))
		&& (value.label === undefined || typeof value.label === "string")
		&& (value.runId === undefined || isId(value.runId))
		&& (value.seq === undefined || (isCount(value.seq) && value.seq > 0))
		&& (value.externalStateBinding === undefined || isExternalStateBinding(value.externalStateBinding))
		&& typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt >= 0
		&& isCount(value.entrySeq);
}

/** Append-only isolated history; checkpoint references do not restore projects. */
export class InMemorySessionStore implements AgentSessionStore {
	private readonly sessions = new Map<string, StoredSession>();
	private readonly checkpoints = new Map<string, AgentCheckpoint>();

	async load(sessionId: string): Promise<AgentSessionSnapshot | null> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		const session = this.sessions.get(sessionId);
		return session ? cloneJson({ sessionId, entries: session.entries }) : null;
	}

	async append(sessionId: string, entry: AgentSessionEntry): Promise<void> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		// Serialize first to validate the full schema and remove opaque error causes.
		const isolated = parseAgentSessionEntry(serializeAgentSessionEntry(entry));
		let session = this.sessions.get(sessionId);
		if (session?.entryIds.has(isolated.id)) throw new Error("Duplicate session entry id");
		if (!session) {
			session = { entries: [], entryIds: new Set(), checkpoints: [] };
			this.sessions.set(sessionId, session);
		}
		// No await between duplicate detection and commit: concurrent calls cannot race.
		session.entries.push(isolated);
		session.entryIds.add(isolated.id);
	}

	async saveCheckpoint(checkpoint: AgentCheckpoint): Promise<void> {
		if (!isCheckpoint(checkpoint)) throw new TypeError("Invalid agent checkpoint");
		const isolated = cloneJson(checkpoint);
		if (!isCheckpoint(isolated)) throw new TypeError("Invalid normalized agent checkpoint");
		if (this.checkpoints.has(isolated.checkpointId)) throw new Error("Duplicate checkpoint id");
		let session = this.sessions.get(isolated.sessionId);
		if (!session && (isolated.entrySeq !== 0 || isolated.parentId !== undefined)) {
			throw new Error("Checkpoint requires an existing session");
		}
		if (isolated.entrySeq > (session?.entries.length ?? 0)) throw new Error("Checkpoint exceeds session boundary");
		if (isolated.parentId !== undefined) {
			const parent = this.checkpoints.get(isolated.parentId);
			if (!parent) throw new Error("Checkpoint parent does not exist");
			if (parent.sessionId !== isolated.sessionId) throw new Error("Checkpoint parent belongs to another session");
			if (parent.entrySeq > isolated.entrySeq) throw new Error("Checkpoint precedes its parent boundary");
		}
		// A root at boundary zero can establish an empty session, after all checks.
		if (!session) {
			session = { entries: [], entryIds: new Set(), checkpoints: [] };
			this.sessions.set(isolated.sessionId, session);
		}
		this.checkpoints.set(isolated.checkpointId, isolated);
		session.checkpoints.push(isolated);
	}

	async listCheckpoints(sessionId: string): Promise<AgentCheckpoint[]> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		return cloneJson(this.sessions.get(sessionId)?.checkpoints ?? []);
	}
}
