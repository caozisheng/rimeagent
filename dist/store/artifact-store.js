import { cloneJson, isJsonValue } from "./json";
import { hasOnlyKeys, isId, isRecord } from "./validation";
const ARTIFACT_KEYS = ["artifactId", "sessionId", "contentType", "value"];
export function isArtifact(value) {
    return isRecord(value) && hasOnlyKeys(value, ARTIFACT_KEYS)
        && ARTIFACT_KEYS.every(key => Object.hasOwn(value, key))
        && isId(value.artifactId) && isId(value.sessionId) && isId(value.contentType)
        && isJsonValue(value.value);
}
/** Immutable JSON artifact storage. Media bytes belong to the host, not this store. */
export class InMemoryArtifactStore {
    artifacts = new Map();
    sessions = new Map();
    async put(record) {
        if (!isArtifact(record))
            throw new TypeError("Invalid JSON artifact");
        const isolated = cloneJson(record);
        if (!isArtifact(isolated))
            throw new TypeError("Invalid normalized JSON artifact");
        if (this.artifacts.has(isolated.artifactId))
            throw new Error("Duplicate artifact id");
        // Validation, duplicate detection and insertion run synchronously as one commit.
        this.artifacts.set(isolated.artifactId, isolated);
        const session = this.sessions.get(isolated.sessionId);
        if (session)
            session.push(isolated);
        else
            this.sessions.set(isolated.sessionId, [isolated]);
    }
    async get(artifactId) {
        if (!isId(artifactId))
            throw new TypeError("Invalid artifact id");
        const artifact = this.artifacts.get(artifactId);
        return artifact ? cloneJson(artifact) : null;
    }
    async list(sessionId) {
        if (!isId(sessionId))
            throw new TypeError("Invalid session id");
        return cloneJson(this.sessions.get(sessionId) ?? []);
    }
}
//# sourceMappingURL=artifact-store.js.map