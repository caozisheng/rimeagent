import { cloneJson } from "./store/json";
import { hasOnlyKeys, isCount, isId, isNormalizedError, isRecord, isTokenUsage, isToolCall, isToolCalls, isToolResult } from "./store/validation";
export const AGENT_RUNTIME_EVENT_VERSION = 2;
const payloadKeys = {
    run_started: ["kind", "sessionId"], run_resumed: ["kind", "sessionId"],
    run_interrupted: ["kind", "cause"], run_awaiting_approval: ["kind", "toolCallId"],
    run_completed: ["kind", "reason", "iterations"], run_failed: ["kind", "error"],
    iteration_start: ["kind", "iteration"], iteration_end: ["kind", "iteration"],
    text_delta: ["type", "content"], tool_calls_complete: ["type", "toolCalls"],
    message_end: ["type", "usage"], error: ["type", "message"], status: ["type", "status"],
    tool_result: ["kind", "toolCall", "result"],
    compaction_completed: ["kind", "droppedEntries", "summaryDigest"], role_switch: ["kind", "roleId"],
};
function isPayload(type, value) {
    if (!isRecord(value) || !hasOnlyKeys(value, payloadKeys[type]))
        return false;
    const discriminator = payloadKeys[type][0];
    if (!Object.hasOwn(value, discriminator) || value[discriminator] !== type)
        return false;
    switch (type) {
        case "run_started":
        case "run_resumed": return Object.hasOwn(value, "sessionId") && isId(value.sessionId);
        case "run_interrupted": return Object.hasOwn(value, "cause") &&
            (value.cause === "provider" || value.cause === "context_overflow" || value.cause === "tool_failure" || value.cause === "interrupted");
        case "run_awaiting_approval": return Object.hasOwn(value, "toolCallId") && isId(value.toolCallId);
        case "run_completed": return (value.reason === undefined || value.reason === "response" || value.reason === "max_iterations")
            && (value.iterations === undefined || isCount(value.iterations));
        case "run_failed": return Object.hasOwn(value, "error") && isNormalizedError(value.error);
        case "iteration_start":
        case "iteration_end": return Object.hasOwn(value, "iteration") && isCount(value.iteration);
        case "text_delta": return Object.hasOwn(value, "content") && typeof value.content === "string";
        case "tool_calls_complete": return Object.hasOwn(value, "toolCalls") && isToolCalls(value.toolCalls);
        case "message_end": return value.usage === undefined || isTokenUsage(value.usage);
        case "error": return Object.hasOwn(value, "message") && typeof value.message === "string";
        case "status": return Object.hasOwn(value, "status") &&
            (value.status === "idle" || value.status === "thinking" || value.status === "streaming" || value.status === "error");
        case "tool_result": return Object.hasOwn(value, "toolCall") && Object.hasOwn(value, "result") && isToolCall(value.toolCall) && isToolResult(value.result);
        case "compaction_completed": return Object.hasOwn(value, "droppedEntries") && Object.hasOwn(value, "summaryDigest") && isCount(value.droppedEntries) && isId(value.summaryDigest);
        case "role_switch": return Object.hasOwn(value, "roleId") && isId(value.roleId);
        default: return false;
    }
}
function validateEnvelope(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ["v", "runId", "seq", "ts", "type", "payload"])
        || !["v", "runId", "seq", "ts", "type", "payload"].every(key => Object.hasOwn(value, key))
        || value.v !== AGENT_RUNTIME_EVENT_VERSION || !isId(value.runId)
        || !isCount(value.seq) || value.seq === 0 || !isId(value.type)
        || typeof value.ts !== "number" || !Number.isFinite(value.ts) || value.ts < 0) {
        throw new TypeError("Invalid runtime event envelope or unsupported version");
    }
}
/** Unknown v2 types are safe to skip; damaged known events are never silently ignored. */
export function parseAgentRuntimeEvent(value) {
    validateEnvelope(value);
    if (!Object.hasOwn(payloadKeys, value.type))
        return null;
    if (!isPayload(value.type, value.payload))
        throw new TypeError("Invalid runtime event payload");
    if ("kind" in value.payload && value.payload.kind === "run_failed" && Object.hasOwn(value.payload.error, "cause")) {
        throw new TypeError("Opaque error cause is not permitted in a persisted runtime event");
    }
    const snapshot = cloneJson(value);
    validateEnvelope(snapshot);
    if (!Object.hasOwn(payloadKeys, snapshot.type))
        return null;
    if (!isPayload(snapshot.type, snapshot.payload))
        throw new TypeError("Invalid runtime event payload");
    if ("kind" in snapshot.payload && snapshot.payload.kind === "run_failed" && Object.hasOwn(snapshot.payload.error, "cause")) {
        throw new TypeError("Opaque error cause is not permitted in a persisted runtime event");
    }
    return snapshot;
}
/** Clock and monotonically increasing sequence are supplied by the runtime owner. */
export function createAgentRuntimeEvent(runId, seq, ts, payload) {
    if (!isRecord(payload))
        throw new TypeError("Runtime event payload must be a data object");
    if (!Object.hasOwn(payload, "kind") && !Object.hasOwn(payload, "type"))
        throw new TypeError("Runtime event requires an own discriminator");
    const type = "kind" in payload ? payload.kind : payload.type;
    if (!Object.hasOwn(payloadKeys, type) || !isPayload(type, payload))
        throw new TypeError("Invalid runtime event payload");
    const persisted = "kind" in payload && payload.kind === "run_failed"
        ? { ...payload, error: { category: payload.error.category, message: payload.error.message, retryable: payload.error.retryable } }
        : payload;
    const event = { v: AGENT_RUNTIME_EVENT_VERSION, runId, seq, ts, type, payload: persisted };
    return parseAgentRuntimeEvent(event);
}
//# sourceMappingURL=events.js.map