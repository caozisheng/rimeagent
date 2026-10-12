import { isAgentSessionEntry } from "../store/validation";
import { computeContextDigest } from "../store/checkpoint";
import { projectMessages } from "./history";
import { parseContextSummary } from "./context-summary";
/** A trailing pending batch is valid, but no cut or interleaved message may break it. */
function inspectProtocol(messages) {
    const pending = new Set();
    const seenCalls = new Set();
    const closedBoundaries = new Set([0]);
    let latestUser = -1;
    let latestBatch = -1;
    let latestCompleteBatch = -1;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === "tool") {
            if (!message.toolCallId || !pending.delete(message.toolCallId))
                throw new TypeError("Session has an unmatched tool result");
            if (!pending.size)
                latestCompleteBatch = latestBatch;
        }
        else {
            if (pending.size)
                throw new TypeError("Session has an interleaved unfinished tool batch");
            if (message.role === "user")
                latestUser = index;
            if (message.toolCalls?.length) {
                if (message.role !== "assistant")
                    throw new TypeError("Tool calls must belong to an assistant");
                latestBatch = index;
                for (const call of message.toolCalls) {
                    if (seenCalls.has(call.id))
                        throw new TypeError("Session has duplicate tool-call IDs");
                    seenCalls.add(call.id);
                    pending.add(call.id);
                }
            }
        }
        if (!pending.size)
            closedBoundaries.add(index + 1);
    }
    const protectedIndex = Math.min(latestUser < 0 ? Infinity : latestUser, latestCompleteBatch < 0 ? Infinity : latestCompleteBatch, pending.size ? latestBatch : Infinity, Math.max(0, messages.length - 1));
    return { closedBoundaries, protectedIndex };
}
export function loadContextHistory(entries) {
    const seenEntries = new Set();
    const messageEntries = [];
    let compactedCount = 0;
    let previousSummary;
    for (const entry of entries) {
        if (!isAgentSessionEntry(entry) || seenEntries.has(entry.id))
            throw new TypeError("Invalid context session history");
        seenEntries.add(entry.id);
        if (entry.kind === "user_message" || entry.kind === "assistant_message" || entry.kind === "tool_result")
            messageEntries.push(entry);
        if (entry.kind !== "compaction")
            continue;
        const ids = entry.compactedEntryIds;
        if (!ids.length || ids.length < compactedCount || ids.length > messageEntries.length || ids.some((id, index) => id !== messageEntries[index].id)) {
            throw new TypeError("Compaction IDs must be a cumulative preceding source-message prefix");
        }
        const protocol = inspectProtocol(projectMessages(messageEntries));
        if (!protocol.closedBoundaries.has(ids.length))
            throw new TypeError("Compaction splits a tool batch");
        if (ids.length > protocol.protectedIndex)
            throw new TypeError("Compaction removes the latest protected conversation exchange");
        compactedCount = ids.length;
        previousSummary = parseContextSummary(entry.summary);
    }
    const messages = projectMessages(messageEntries);
    const protocol = inspectProtocol(messages);
    return { entries, messages, ...protocol, compactedCount, ...(previousSummary === undefined ? {} : { previousSummary }) };
}
/** Durable checkpoints fence prefix cuts in entry space, not filtered message space. */
export function chooseContextCut(history, checkpoints, sessionId) {
    let cut = history.compactedCount;
    let selected;
    const messageCounts = [0];
    for (const entry of history.entries) {
        const isMessage = entry.kind === "user_message" || entry.kind === "assistant_message" || entry.kind === "tool_result";
        messageCounts.push(messageCounts.at(-1) + (isMessage ? 1 : 0));
    }
    for (const checkpoint of checkpoints) {
        if (checkpoint.sessionId !== sessionId || !Number.isSafeInteger(checkpoint.entrySeq) || checkpoint.entrySeq < 0 || checkpoint.entrySeq > history.entries.length) {
            throw new TypeError("Invalid context checkpoint boundary");
        }
        const count = messageCounts[checkpoint.entrySeq];
        if (count <= cut || count > history.protectedIndex || !history.closedBoundaries.has(count))
            continue;
        cut = count;
        selected = checkpoint;
    }
    if (selected && computeContextDigest(history.messages.slice(0, cut)) !== selected.contextDigest) {
        throw new TypeError("Context checkpoint digest mismatch");
    }
    return cut;
}
//# sourceMappingURL=context-history.js.map