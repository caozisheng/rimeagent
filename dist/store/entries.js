import { cloneJson } from "./json";
import { isAgentSessionEntry } from "./validation";
export { isAgentSessionEntry };
function withoutOpaqueCause(entry) {
    const source = entry;
    const kind = Object.getOwnPropertyDescriptor(source, "kind").value;
    const result = {};
    for (const key of Reflect.ownKeys(source)) {
        if (typeof key !== "string")
            throw new TypeError("Session entry contains a symbol key");
        if ((kind === "error" || kind === "run_failed") && key === "error")
            continue;
        Object.defineProperty(result, key, { value: Object.getOwnPropertyDescriptor(source, key).value,
            enumerable: true, writable: true, configurable: true });
    }
    if (kind === "error" || kind === "run_failed") {
        const error = Object.getOwnPropertyDescriptor(source, "error").value;
        result.error = {
            category: Object.getOwnPropertyDescriptor(error, "category").value,
            message: Object.getOwnPropertyDescriptor(error, "message").value,
            retryable: Object.getOwnPropertyDescriptor(error, "retryable").value,
        };
    }
    return result;
}
export function serializeAgentSessionEntry(entry) {
    if (!isAgentSessionEntry(entry))
        throw new TypeError("Invalid session entry");
    const snapshot = cloneJson(withoutOpaqueCause(entry));
    if (!isAgentSessionEntry(snapshot))
        throw new TypeError("Invalid normalized session entry");
    if ((snapshot.kind === "error" || snapshot.kind === "run_failed") && Object.hasOwn(snapshot.error, "cause")) {
        throw new TypeError("Opaque error cause is not permitted in serialized entries");
    }
    return JSON.stringify(snapshot);
}
export function parseAgentSessionEntry(json) {
    let value;
    try {
        value = JSON.parse(json);
    }
    catch {
        throw new TypeError("Invalid session entry JSON");
    }
    if (!isAgentSessionEntry(value))
        throw new TypeError("Invalid persisted session entry");
    if (value.kind === "error" || value.kind === "run_failed") {
        const error = value.error;
        if (Object.hasOwn(error, "cause"))
            throw new TypeError("Opaque error cause is not permitted in persisted entries");
    }
    return cloneJson(value);
}
//# sourceMappingURL=entries.js.map