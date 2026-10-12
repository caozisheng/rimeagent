import type { JsonValue } from "./json";
import { cloneJson, isJsonValue } from "./json";
import { hasOnlyKeys, isId, isRecord } from "./validation";

export interface AgentArtifact {
	readonly artifactId: string;
	readonly sessionId: string;
	readonly contentType: string;
	readonly value: JsonValue;
}

export interface AgentArtifactStore {
	put(record: AgentArtifact): Promise<void>;
	get(artifactId: string): Promise<AgentArtifact | null>;
	list(sessionId: string): Promise<AgentArtifact[]>;
}

const ARTIFACT_KEYS = ["artifactId", "sessionId", "contentType", "value"];

export function isArtifact(value: unknown): value is AgentArtifact {
	return isRecord(value) && hasOnlyKeys(value, ARTIFACT_KEYS)
		&& ARTIFACT_KEYS.every(key => Object.hasOwn(value, key))
		&& isId(value.artifactId) && isId(value.sessionId) && isId(value.contentType)
		&& isJsonValue(value.value);
}

/** Immutable JSON artifact storage. Media bytes belong to the host, not this store. */
export class InMemoryArtifactStore implements AgentArtifactStore {
	private readonly artifacts = new Map<string, AgentArtifact>();
	private readonly sessions = new Map<string, AgentArtifact[]>();

	async put(record: AgentArtifact): Promise<void> {
		if (!isArtifact(record)) throw new TypeError("Invalid JSON artifact");
		const isolated = cloneJson(record);
		if (!isArtifact(isolated)) throw new TypeError("Invalid normalized JSON artifact");
		if (this.artifacts.has(isolated.artifactId)) throw new Error("Duplicate artifact id");
		// Validation, duplicate detection and insertion run synchronously as one commit.
		this.artifacts.set(isolated.artifactId, isolated);
		const session = this.sessions.get(isolated.sessionId);
		if (session) session.push(isolated);
		else this.sessions.set(isolated.sessionId, [isolated]);
	}

	async get(artifactId: string): Promise<AgentArtifact | null> {
		if (!isId(artifactId)) throw new TypeError("Invalid artifact id");
		const artifact = this.artifacts.get(artifactId);
		return artifact ? cloneJson(artifact) : null;
	}

	async list(sessionId: string): Promise<AgentArtifact[]> {
		if (!isId(sessionId)) throw new TypeError("Invalid session id");
		return cloneJson(this.sessions.get(sessionId) ?? []);
	}
}
