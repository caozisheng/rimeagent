import type { LedgerRecord, RuntimeLedger } from "../runtime/ledger";
import type { IndexedDBHandle } from "./indexeddb-database";
export declare class IndexedDBLedger implements RuntimeLedger {
    private readonly handle;
    constructor(handle: IndexedDBHandle);
    append(record: LedgerRecord): Promise<void>;
    hasExecuted(toolCallId: string): Promise<boolean>;
    getToolExecution(toolCallId: string): Promise<LedgerRecord | null>;
    query(runId: string): Promise<LedgerRecord[]>;
}
//# sourceMappingURL=indexeddb-ledger.d.ts.map