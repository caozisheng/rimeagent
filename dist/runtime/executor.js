import { nanoid } from "nanoid";
import { normalizeError } from "../errors";
import { computeContextDigest } from "../store/checkpoint";
import { canonicalJson, cloneJson } from "../store/json";
import { isCount, isId, isRecord, isToolCall, isToolResult } from "../store/validation";
const textEncoder = new TextEncoder();
const TOOL_RESULT_CONTENT_TYPE = "application/json";
function failure(message) {
    return { success: false, message };
}
function digest(value) {
    const bytes = textEncoder.encode(canonicalJson(value));
    let hash = 0x811c9dc5;
    for (const byte of bytes)
        hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, "0");
}
function argsDigest(call) {
    return computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
}
function parseArguments(call) {
    try {
        const parsed = JSON.parse(call.function.arguments);
        if (!isRecord(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function validateResultMetadata(result) {
    if (result.data === undefined)
        return {};
    if (!isRecord(result.data))
        throw new TypeError("Tool result data must be a plain object");
    for (const key of ["commandId", "projectRevisionBefore", "projectRevisionAfter"]) {
        if (!Object.hasOwn(result.data, key))
            continue;
        const value = result.data[key];
        if (key === "commandId" && !isId(value))
            throw new TypeError("Invalid tool result commandId");
        if ((key === "projectRevisionBefore" || key === "projectRevisionAfter") && !isCount(value)) {
            throw new TypeError(`Invalid tool result ${key}`);
        }
    }
    return {
        ...(Object.hasOwn(result.data, "commandId") ? { commandId: result.data.commandId } : {}),
        ...(Object.hasOwn(result.data, "projectRevisionBefore") ? { projectRevisionBefore: result.data.projectRevisionBefore } : {}),
        ...(Object.hasOwn(result.data, "projectRevisionAfter") ? { projectRevisionAfter: result.data.projectRevisionAfter } : {}),
    };
}
function replayError(message, toolName) {
    throw normalizeError(new Error(message), { toolName });
}
export function createToolExecutor(options) {
    if (!isId(options.sessionId))
        throw new TypeError("Invalid session id");
    const tools = new Map();
    for (const tool of options.tools)
        tools.set(tool.name, tool);
    let tail = Promise.resolve();
    const readCachedResult = async (record) => {
        if (record.event.kind !== "tool_exec" || !record.event.artifactId) {
            throw new Error("Tool execution has no cached artifact");
        }
        const artifact = await options.artifactStore.get(record.event.artifactId);
        if (!artifact || !isRecord(artifact) || artifact.artifactId !== record.event.artifactId || artifact.sessionId !== options.sessionId || artifact.contentType !== TOOL_RESULT_CONTENT_TYPE
            || !isToolResult(artifact.value)) {
            throw new Error("Missing or corrupt cached tool result artifact");
        }
        if ((record.event.outcome === "success") !== artifact.value.success) {
            throw new Error("Cached tool result outcome does not match ledger");
        }
        return cloneJson(artifact.value);
    };
    const executeOne = async (call, context) => {
        if (context.signal?.aborted)
            return failure("Operation was aborted");
        if (!isToolCall(call) || !isId(context.runId))
            return failure("Invalid tool call");
        const parsed = parseArguments(call);
        if (!parsed)
            return failure("Invalid JSON arguments");
        const tool = tools.get(call.function.name);
        const callArgsDigest = argsDigest(call);
        const prior = await options.ledger.getToolExecution(call.id);
        if (prior) {
            if (prior.event.kind !== "tool_intent" && prior.event.kind !== "tool_exec")
                throw new Error("Invalid tool replay record");
            if (prior.event.tool !== call.function.name || prior.event.argsDigest !== callArgsDigest) {
                replayError("Tool call id was reused with different arguments", call.function.name);
            }
            if (prior.event.kind === "tool_exec")
                return readCachedResult(prior);
            const annotations = tool?.annotations;
            if (!tool || annotations?.requiresApproval || annotations?.destructive || tool.requiresConfirmation) {
                return failure("Tool requires approval");
            }
            if (!(annotations?.readOnly || annotations?.idempotent)) {
                replayError("Tool call has an uncertain external effect", call.function.name);
            }
            const priorRun = await options.ledger.query(context.runId);
            let attempts = 0;
            for (const item of priorRun)
                if (item.event.kind === "retry" && item.event.toolCallId === call.id)
                    attempts++;
            await options.ledger.append({ runId: context.runId, seq: context.nextSeq(), ts: Date.now(), event: { kind: "retry", toolCallId: call.id, attempt: attempts + 1, category: "tool_failure" } });
        }
        else {
            if (!tool)
                return failure(`Unknown tool: ${call.function.name}`);
            if (tool.annotations?.requiresApproval || tool.annotations?.destructive || tool.requiresConfirmation) {
                return failure("Tool requires approval");
            }
            // A losing concurrent writer keeps the durable claim error. It must not guess
            // whether the winning writer has already performed its external side effect.
            await options.ledger.append({ runId: context.runId, seq: context.nextSeq(), ts: Date.now(), event: { kind: "tool_intent", toolCallId: call.id, tool: call.function.name, argsDigest: callArgsDigest } });
        }
        let result;
        try {
            result = await tool.execute(parsed);
        }
        catch (cause) {
            const error = normalizeError(cause, { toolName: call.function.name });
            result = failure(error.message);
        }
        if (!isToolResult(result))
            throw new TypeError("Tool returned an invalid result");
        const metadata = validateResultMetadata(result);
        const artifactId = nanoid();
        await options.artifactStore.put({ artifactId, sessionId: options.sessionId, contentType: TOOL_RESULT_CONTENT_TYPE, value: cloneJson(result) });
        const event = {
            kind: "tool_exec", toolCallId: call.id, tool: call.function.name, argsDigest: callArgsDigest,
            outcome: result.success ? "success" : "failure", messageDigest: digest(result.message), artifactId,
            ...metadata,
        };
        await options.ledger.append({ runId: context.runId, seq: context.nextSeq(), ts: Date.now(), event });
        return cloneJson(result);
    };
    return {
        execute(call, context) {
            const result = tail.then(() => executeOne(call, context));
            tail = result.then(() => undefined, () => undefined);
            return result;
        },
    };
}
//# sourceMappingURL=executor.js.map