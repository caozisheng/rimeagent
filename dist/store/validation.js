import { isJsonValue } from "./json";
const ERROR_CATEGORIES = {
    provider: true, context_overflow: true, tool_failure: true, interrupted: true,
};
const SUGGESTION_TYPES = {
    similar_id: true, similar_name: true, similar_file: true, syntax_hint: true, alternative: true,
};
const ENTRY_KEYS = {
    user_message: ["kind", "id", "ts", "content"],
    assistant_message: ["kind", "id", "ts", "content", "toolCalls", "usage"],
    tool_call: ["kind", "id", "ts", "toolCallId", "name", "argsDigest"],
    tool_result: ["kind", "id", "ts", "toolCallId", "result", "artifactId"],
    approval_requested: ["kind", "id", "ts", "toolCallId", "reason"],
    approval_resolved: ["kind", "id", "ts", "toolCallId", "decision", "by"],
    compaction: ["kind", "id", "ts", "summary", "compactedEntryIds", "projectDigest"],
    checkpoint: ["kind", "id", "ts", "checkpointId", "projectRevision"],
    branch: ["kind", "id", "ts", "fromCheckpointId", "branchId"],
    run_started: ["kind", "id", "ts", "runId", "parentRunId"],
    run_interrupted: ["kind", "id", "ts", "runId", "cause", "lastDurableBoundary"],
    run_awaiting_approval: ["kind", "id", "ts", "runId", "toolCallId"],
    run_completed: ["kind", "id", "ts", "runId", "reason", "iterations"],
    run_failed: ["kind", "id", "ts", "runId", "error"],
    error: ["kind", "id", "ts", "error"],
    usage: ["kind", "id", "ts", "runId", "usage"],
};
function ownDescriptor(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && "value" in descriptor && !descriptor.get && !descriptor.set ? descriptor : undefined;
}
export function isRecord(value) {
    try {
        if (typeof value !== "object" || value === null || Array.isArray(value))
            return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string" || !ownDescriptor(value, key))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
export function hasOnlyKeys(record, keys) {
    try {
        if (!isRecord(record))
            return false;
        return Reflect.ownKeys(record).every(key => typeof key === "string" && keys.includes(key));
    }
    catch {
        return false;
    }
}
export function isId(value) {
    return typeof value === "string" && value.length > 0;
}
export function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isCategory(value) {
    return typeof value === "string" && ERROR_CATEGORIES[value] === true;
}
function required(record, key, predicate) {
    const descriptor = ownDescriptor(record, key);
    return descriptor !== undefined && predicate(descriptor.value);
}
function optional(record, key, predicate) {
    const descriptor = ownDescriptor(record, key);
    return descriptor === undefined || descriptor.value === undefined || predicate(descriptor.value);
}
function isArrayOf(value, predicate) {
    try {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
            return false;
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor) || !isCount(lengthDescriptor.value))
            return false;
        const length = lengthDescriptor.value;
        for (const key of Reflect.ownKeys(value)) {
            if (key === "length")
                continue;
            if (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= length || String(Number(key)) !== key)
                return false;
        }
        for (let index = 0; index < length; index++) {
            const descriptor = ownDescriptor(value, String(index));
            if (!descriptor || !predicate(descriptor.value))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
export function isToolCall(value) {
    try {
        if (!isRecord(value) || !hasOnlyKeys(value, ["id", "type", "function"]) || !required(value, "id", isId) || !required(value, "type", item => item === "function"))
            return false;
        const fn = ownDescriptor(value, "function")?.value;
        return isRecord(fn) && hasOnlyKeys(fn, ["name", "arguments"]) && required(fn, "name", isId) && required(fn, "arguments", item => typeof item === "string");
    }
    catch {
        return false;
    }
}
/** Validates dense own elements without invoking caller-controlled array methods. */
export function isToolCalls(value) {
    return isArrayOf(value, isToolCall);
}
export function isTokenUsage(value) {
    try {
        if (!isRecord(value) || !hasOnlyKeys(value, ["promptTokens", "completionTokens", "totalTokens", "cost", "cacheReadTokens", "cacheWriteTokens"]))
            return false;
        for (const key of ["promptTokens", "completionTokens", "totalTokens", "cost", "cacheReadTokens", "cacheWriteTokens"]) {
            const descriptor = ownDescriptor(value, key);
            if (descriptor && descriptor.value !== undefined && (typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value) || descriptor.value < 0))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function isToolSuggestion(value) {
    return isRecord(value) && hasOnlyKeys(value, ["type", "text"]) && required(value, "type", item => typeof item === "string" && SUGGESTION_TYPES[item] === true) && required(value, "text", item => typeof item === "string");
}
export function isToolResult(value) {
    try {
        return isRecord(value) && hasOnlyKeys(value, ["success", "message", "data", "undoable", "suggestions"])
            && required(value, "success", item => typeof item === "boolean")
            && required(value, "message", item => typeof item === "string")
            && optional(value, "data", item => isRecord(item) && isJsonValue(item))
            && optional(value, "undoable", item => typeof item === "boolean")
            && optional(value, "suggestions", item => isArrayOf(item, isToolSuggestion));
    }
    catch {
        return false;
    }
}
export function isNormalizedError(value) {
    try {
        return isRecord(value) && hasOnlyKeys(value, ["category", "message", "retryable", "cause"])
            && required(value, "category", isCategory)
            && required(value, "message", item => typeof item === "string")
            && required(value, "retryable", item => typeof item === "boolean");
    }
    catch {
        return false;
    }
}
export function isProjectFacts(value) {
    try {
        return isRecord(value) && hasOnlyKeys(value, ["projectId", "projectRevision", "digest", "summary", "producedBy"])
            && required(value, "projectRevision", isCount)
            && required(value, "digest", item => typeof item === "string")
            && required(value, "producedBy", item => item === "host")
            && optional(value, "projectId", isId)
            && optional(value, "summary", item => typeof item === "string");
    }
    catch {
        return false;
    }
}
export function isAgentSessionEntry(value) {
    try {
        if (!isRecord(value) || !required(value, "kind", item => typeof item === "string" && Object.hasOwn(ENTRY_KEYS, item)))
            return false;
        const kind = ownDescriptor(value, "kind")?.value;
        if (!hasOnlyKeys(value, ENTRY_KEYS[kind]) || !required(value, "id", isId) || !required(value, "ts", isTimestamp))
            return false;
        switch (kind) {
            case "user_message": return required(value, "content", item => typeof item === "string");
            case "assistant_message": return required(value, "content", item => typeof item === "string") && optional(value, "toolCalls", isToolCalls) && optional(value, "usage", isTokenUsage);
            case "tool_call": return required(value, "toolCallId", isId) && required(value, "name", isId) && required(value, "argsDigest", isId);
            case "tool_result": return required(value, "toolCallId", isId) && required(value, "result", isToolResult) && optional(value, "artifactId", isId);
            case "approval_requested": return required(value, "toolCallId", isId) && required(value, "reason", item => typeof item === "string");
            case "approval_resolved": return required(value, "toolCallId", isId) && required(value, "decision", item => item === "allow" || item === "deny") && required(value, "by", item => item === "user" || item === "policy");
            case "compaction": return required(value, "summary", item => typeof item === "string") && required(value, "compactedEntryIds", item => isArrayOf(item, isId)) && required(value, "projectDigest", isProjectFacts);
            case "checkpoint": return required(value, "checkpointId", isId) && optional(value, "projectRevision", isCount);
            case "branch": return required(value, "fromCheckpointId", isId) && required(value, "branchId", isId);
            case "run_started": return required(value, "runId", isId) && optional(value, "parentRunId", isId);
            case "run_interrupted": return required(value, "runId", isId) && required(value, "cause", isCategory) && optional(value, "lastDurableBoundary", isId);
            case "run_awaiting_approval": return required(value, "runId", isId) && required(value, "toolCallId", isId);
            case "run_completed": return required(value, "runId", isId)
                && optional(value, "reason", item => item === "response" || item === "max_iterations") && optional(value, "iterations", isCount);
            case "run_failed": return required(value, "runId", isId) && required(value, "error", isNormalizedError);
            case "error": return required(value, "error", isNormalizedError);
            case "usage": return required(value, "runId", isId) && required(value, "usage", isTokenUsage);
            default: return false;
        }
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=validation.js.map