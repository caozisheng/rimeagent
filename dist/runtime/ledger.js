import { cloneJson } from "../store/json";
import { hasOnlyKeys, isCount, isExecutionReceipt, isId, isRecord, isTokenUsage } from "../store/validation";
const eventKeys = {
    model_call: ["kind", "provider", "model", "requestIndex", "usage"],
    tool_intent: ["kind", "toolCallId", "tool", "argsDigest"],
    tool_exec: [
        "kind", "toolCallId", "tool", "argsDigest", "outcome", "messageDigest",
        "artifactId", "receipt",
    ],
    retry: ["kind", "toolCallId", "attempt", "category"],
    approval: ["kind", "toolCallId", "decision"],
    terminal: ["kind", "status"],
    compaction: ["kind", "detail"],
    cancellation: ["kind", "detail"],
};
const errorCategories = {
    provider: true,
    context_overflow: true,
    tool_failure: true,
    interrupted: true,
};
export function isLedgerRecord(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ["runId", "seq", "ts", "event"])
        || !["runId", "seq", "ts", "event"].every(key => Object.hasOwn(value, key))
        || !isId(value.runId) || !isCount(value.seq) || value.seq === 0
        || typeof value.ts !== "number" || !Number.isFinite(value.ts) || value.ts < 0)
        return false;
    const event = value.event;
    if (!isRecord(event) || !Object.hasOwn(event, "kind") || typeof event.kind !== "string" || !Object.hasOwn(eventKeys, event.kind)
        || !hasOnlyKeys(event, eventKeys[event.kind]))
        return false;
    switch (event.kind) {
        case "model_call":
            return ["provider", "model", "requestIndex", "usage"].every(key => Object.hasOwn(event, key))
                && isId(event.provider) && isId(event.model) && isCount(event.requestIndex)
                && isTokenUsage(event.usage);
        case "tool_intent":
            return ["toolCallId", "tool", "argsDigest"].every(key => Object.hasOwn(event, key))
                && isId(event.toolCallId) && isId(event.tool) && isId(event.argsDigest);
        case "tool_exec":
            return ["toolCallId", "tool", "argsDigest", "outcome", "messageDigest"].every(key => Object.hasOwn(event, key))
                && isId(event.toolCallId) && isId(event.tool) && isId(event.argsDigest)
                && isId(event.messageDigest) && (event.outcome === "success" || event.outcome === "failure")
                && (event.artifactId === undefined || isId(event.artifactId))
                && (event.receipt === undefined || isExecutionReceipt(event.receipt));
        case "retry":
            return ["attempt", "category"].every(key => Object.hasOwn(event, key))
                && (event.toolCallId === undefined || isId(event.toolCallId)) && isCount(event.attempt)
                && typeof event.category === "string" && Object.hasOwn(errorCategories, event.category);
        case "approval":
            return Object.hasOwn(event, "toolCallId") && Object.hasOwn(event, "decision") && isId(event.toolCallId)
                && (event.decision === "allow" || event.decision === "deny" || event.decision === "suspend");
        case "terminal":
            return event.status === "completed" || event.status === "failed" || event.status === "interrupted" || event.status === "awaiting_approval";
        case "compaction":
        case "cancellation":
            return event.detail === undefined || typeof event.detail === "string";
        default:
            return false;
    }
}
/**
 * Append-only in-memory history. Only allowlisted fields are accepted; supplied
 * digest/detail strings are not inspected for semantic secrets or redacted.
 */
export class InMemoryLedger {
    recordsByRun = new Map();
    successfulToolCallIds = new Set();
    successfulExecutions = new Map();
    latestToolRecords = new Map();
    claimedIntents = new Set();
    async append(record) {
        if (!isLedgerRecord(record))
            throw new TypeError("Invalid ledger record");
        // Validate before cloning so an unknown undefined property cannot disappear.
        const snapshot = cloneJson(record);
        if (!isLedgerRecord(snapshot))
            throw new TypeError("Invalid normalized ledger record");
        const records = this.recordsByRun.get(snapshot.runId);
        const previous = records?.at(-1);
        if (previous && snapshot.seq <= previous.seq) {
            throw new Error("Ledger sequence must strictly increase within a run");
        }
        if (snapshot.event.kind === "tool_intent" && this.claimedIntents.has(snapshot.event.toolCallId)) {
            throw new Error("Tool call intent already claimed");
        }
        // No await between validation and commit: failed appends cannot mutate either index.
        if (records)
            records.push(snapshot);
        else
            this.recordsByRun.set(snapshot.runId, [snapshot]);
        if (snapshot.event.kind === "tool_intent") {
            this.claimedIntents.add(snapshot.event.toolCallId);
            this.latestToolRecords.set(snapshot.event.toolCallId, snapshot);
        }
        else if (snapshot.event.kind === "tool_exec") {
            this.latestToolRecords.set(snapshot.event.toolCallId, snapshot);
            if (snapshot.event.outcome === "success") {
                this.successfulToolCallIds.add(snapshot.event.toolCallId);
                this.successfulExecutions.set(snapshot.event.toolCallId, snapshot);
            }
        }
    }
    async hasExecuted(toolCallId) {
        if (!isId(toolCallId))
            throw new TypeError("Invalid tool call id");
        return this.successfulToolCallIds.has(toolCallId);
    }
    async getToolExecution(toolCallId) {
        if (!isId(toolCallId))
            throw new TypeError("Invalid tool call id");
        const record = this.successfulExecutions.get(toolCallId) ?? this.latestToolRecords.get(toolCallId);
        return record ? cloneJson(record) : null;
    }
    async query(runId) {
        if (!isId(runId))
            throw new TypeError("Invalid run id");
        return cloneJson(this.recordsByRun.get(runId) ?? []);
    }
}
//# sourceMappingURL=ledger.js.map