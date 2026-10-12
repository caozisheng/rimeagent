import { isLedgerRecord } from "../runtime/ledger";
import { cloneJson } from "../store/json";
import { isId } from "../store/validation";
import { request } from "./indexeddb-database";
export class IndexedDBLedger {
    handle;
    constructor(handle) {
        this.handle = handle;
    }
    async append(record) {
        if (!isLedgerRecord(record))
            throw new TypeError("Invalid ledger record");
        const snapshot = cloneJson(record);
        if (!isLedgerRecord(snapshot))
            throw new TypeError("Invalid normalized ledger record");
        await this.handle.transaction(["runs", "ledger", "claims"], "readwrite", async (transaction) => {
            const runs = transaction.objectStore("runs");
            const previous = await request(runs.get(snapshot.runId));
            if (previous && snapshot.seq <= previous.seq)
                throw new Error("Ledger sequence must strictly increase within a run");
            const event = snapshot.event;
            if (event.kind === "tool_intent" || event.kind === "tool_exec") {
                const claims = transaction.objectStore("claims");
                const claim = await request(claims.get(event.toolCallId)) ?? { toolCallId: event.toolCallId };
                const key = [snapshot.runId, snapshot.seq];
                if (event.kind === "tool_intent") {
                    if (claim.intent)
                        throw new Error("Duplicate global tool intent");
                    claim.intent = key;
                }
                else {
                    if (event.outcome === "success")
                        claim.successful = key;
                }
                claim.latest = key;
                await request(claims.put(claim));
            }
            await request(runs.put({ runId: snapshot.runId, seq: snapshot.seq }));
            await request(transaction.objectStore("ledger").add(snapshot));
        });
    }
    async hasExecuted(toolCallId) {
        if (!isId(toolCallId))
            throw new TypeError("Invalid tool call id");
        return this.handle.transaction(["claims"], "readonly", async (transaction) => {
            const claim = await request(transaction.objectStore("claims").get(toolCallId));
            return claim?.successful !== undefined;
        });
    }
    async getToolExecution(toolCallId) {
        if (!isId(toolCallId))
            throw new TypeError("Invalid tool call id");
        return this.handle.transaction(["claims", "ledger"], "readonly", async (transaction) => {
            const claim = await request(transaction.objectStore("claims").get(toolCallId));
            const key = claim?.successful ?? claim?.latest ?? claim?.intent;
            if (!key)
                return null;
            const value = await request(transaction.objectStore("ledger").get(key));
            if (!isLedgerRecord(value))
                throw new TypeError("Invalid persisted execution record");
            return cloneJson(value);
        });
    }
    async query(runId) {
        if (!isId(runId))
            throw new TypeError("Invalid run id");
        return this.handle.transaction(["ledger"], "readonly", async (transaction) => {
            const records = await request(transaction.objectStore("ledger").index("run").getAll(runId));
            const result = [];
            for (const record of records) {
                if (!isLedgerRecord(record))
                    throw new TypeError("Invalid persisted ledger record");
                result.push(cloneJson(record));
            }
            return result;
        });
    }
}
//# sourceMappingURL=indexeddb-ledger.js.map