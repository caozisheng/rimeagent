import { describe, expect, spyOn, test } from "bun:test";
import { IDBDatabase as FakeDatabase, IDBFactory, IDBIndex as FakeIndex, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import type { LedgerRecord } from "../../src/runtime/ledger";
import type { AgentArtifact } from "../../src/store/artifact-store";
import type { AgentCheckpoint } from "../../src/store/checkpoint";
import type { AgentSessionEntry } from "../../src/store/entries";
import { createIndexedDBStores } from "../../src/adapters/indexeddb";

const entry = (id = "entry"): AgentSessionEntry => ({ kind: "user_message", id, ts: 1, content: "hello" });
const checkpoint = (changes: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
	checkpointId: "root", sessionId: "s", createdAt: 1, entrySeq: 0, contextDigest: "12345678", ...changes,
});
const artifact = (changes: Partial<AgentArtifact> = {}): AgentArtifact => ({
	artifactId: "artifact", sessionId: "s", contentType: "application/json", value: { nested: ["original"] }, ...changes,
});
const record = (seq: number, event: LedgerRecord["event"], runId = "run"): LedgerRecord => ({ runId, seq, ts: 1, event });
const intent: LedgerRecord["event"] = { kind: "tool_intent", toolCallId: "call", tool: "edit", argsDigest: "digest" };
const execution: LedgerRecord["event"] = {
	kind: "tool_exec", toolCallId: "call", tool: "edit", argsDigest: "digest", outcome: "success",
	messageDigest: "message", artifactId: "artifact", commandId: "command", projectRevisionBefore: 0, projectRevisionAfter: 1,
};

function fixture() {
	const indexedDB = new IDBFactory();
	const open = () => createIndexedDBStores({ name: "isolated", indexedDB });
	return { indexedDB, open };
}

const entries: AgentSessionEntry[] = [
	entry(),
	{ kind: "assistant_message", id: "assistant", ts: 1, content: "answer", usage: { totalTokens: 3 }, toolCalls: [{ id: "call", type: "function", function: { name: "edit", arguments: "{}" } }] },
	{ kind: "tool_call", id: "tool-call", ts: 1, toolCallId: "call", name: "edit", argsDigest: "digest" },
	{ kind: "tool_result", id: "tool-result", ts: 1, toolCallId: "call", result: { success: true, message: "done", data: { nested: [1] } }, artifactId: "artifact" },
	{ kind: "approval_requested", id: "requested", ts: 1, toolCallId: "call", reason: "danger" },
	{ kind: "approval_resolved", id: "resolved", ts: 1, toolCallId: "call", decision: "allow", by: "user" },
	{ kind: "compaction", id: "compaction", ts: 1, summary: "summary", compactedEntryIds: ["entry"], projectDigest: { producedBy: "host", digest: "project", projectId: "p", projectRevision: 1 } },
	{ kind: "checkpoint", id: "checkpoint", ts: 1, checkpointId: "root", projectRevision: 1 },
	{ kind: "branch", id: "branch", ts: 1, fromCheckpointId: "root", branchId: "branch" },
	{ kind: "run_started", id: "started", ts: 1, runId: "run", parentRunId: "prior" },
	{ kind: "run_state", id: "state", ts: 1, runId: "run", seq: 4, iteration: 1, phase: "tools", activeRoleId: "role", checkpointId: "root" },
	{ kind: "run_interrupted", id: "interrupted", ts: 1, runId: "run", cause: "interrupted", lastDurableBoundary: "root" },
	{ kind: "run_awaiting_approval", id: "awaiting", ts: 1, runId: "run", toolCallId: "call" },
	{ kind: "run_completed", id: "completed", ts: 1, runId: "run", reason: "response", iterations: 1 },
	{ kind: "run_failed", id: "failed", ts: 1, runId: "run", error: { category: "provider", message: "failed", retryable: true } },
	{ kind: "error", id: "error", ts: 1, error: { category: "tool_failure", message: "failed", retryable: false } },
	{ kind: "usage", id: "usage", ts: 1, runId: "run", usage: { totalTokens: 3 } },
];
const events: LedgerRecord["event"][] = [
	{ kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: { totalTokens: 3 } },
	intent, execution, { kind: "retry", toolCallId: "call", attempt: 1, category: "tool_failure" },
	{ kind: "approval", toolCallId: "call", decision: "suspend" },
	{ kind: "compaction", detail: "digest" }, { kind: "cancellation", detail: "cancelled" },
	{ kind: "terminal", status: "interrupted" },
];

describe("IndexedDB stores", () => {
	test("reopens all entry, checkpoint, artifact and ledger shapes repeatedly in insertion order", async () => {
		const { open } = fixture();
		let bundle = await open();
		await bundle.sessionStore.saveCheckpoint(checkpoint());
		expect(await bundle.sessionStore.load("s")).toEqual({ sessionId: "s", entries: [] });
		for (const value of entries) await bundle.sessionStore.append("s", value);
		const child = checkpoint({ checkpointId: "a-child", parentId: "root", entrySeq: entries.length, runId: "run", seq: 5, projectId: "p", projectRevision: 1, projectCheckpointId: "host-checkpoint" });
		await bundle.sessionStore.saveCheckpoint(child);
		await bundle.artifactStore.put(artifact({ artifactId: "z" }));
		await bundle.artifactStore.put(artifact());
		const records = events.map((event, index) => record((index + 1) * 2, event));
		for (const value of records) await bundle.ledger.append(value);
		for (let iteration = 0; iteration < 3; iteration++) {
			bundle.close();
			bundle = await open();
			expect(await bundle.sessionStore.load("s")).toEqual({ sessionId: "s", entries });
			expect(await bundle.sessionStore.listCheckpoints("s")).toEqual([checkpoint(), child]);
			expect(await bundle.artifactStore.list("s")).toEqual([artifact({ artifactId: "z" }), artifact()]);
			expect(await bundle.ledger.query("run")).toEqual(records);
			expect(await bundle.ledger.getToolExecution("call")).toEqual(records[2]!);
			expect(await bundle.artifactStore.get("artifact")).toEqual(artifact());
		}
		bundle.close();
	});

	test("isolates nested inputs and snapshots and removes opaque causes before persistence", async () => {
		const { open } = fixture();
		const bundle = await open();
		const cause: Record<string, unknown> = { apiKey: "private" }; cause.self = cause;
		await bundle.sessionStore.append("s", { kind: "error", id: "error", ts: 1, error: { category: "provider", message: "failed", retryable: true, cause } });
		const input = { artifactId: "artifact", sessionId: "s", contentType: "application/json", value: { nested: ["original"], omitted: undefined } };
		await bundle.artifactStore.put(input); input.value.nested[0] = "changed";
		const model: LedgerRecord["event"] = { kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: { totalTokens: 3 } };
		await bundle.ledger.append(record(1, model)); model.usage.totalTokens = 99;
		const snapshot = (await bundle.artifactStore.get("artifact"))!; Reflect.set(snapshot.value as object, "nested", ["changed"]);
		const ledgerSnapshot = await bundle.ledger.query("run"); ledgerSnapshot.pop();
		bundle.close();
		const reopened = await open();
		expect(JSON.stringify(await reopened.sessionStore.load("s"))).not.toContain("private");
		expect((await reopened.sessionStore.load("s"))?.entries[0]).toEqual({ kind: "error", id: "error", ts: 1, error: { category: "provider", message: "failed", retryable: true } });
		expect(await reopened.artifactStore.get("artifact")).toEqual(artifact());
		expect((await reopened.ledger.query("run"))[0]?.event).toMatchObject({ usage: { totalTokens: 3 } });
		reopened.close();
	});

	test("two handles atomically reject duplicate entries, checkpoint IDs, artifacts and global intents", async () => {
		const { open } = fixture();
		const first = await open(); const second = await open();
		for (const write of [
			() => [first.sessionStore.append("s", entry()), second.sessionStore.append("s", entry())],
			() => [first.sessionStore.saveCheckpoint(checkpoint()), second.sessionStore.saveCheckpoint(checkpoint({ sessionId: "other" }))],
			() => [first.artifactStore.put(artifact()), second.artifactStore.put(artifact({ sessionId: "other" }))],
			() => [first.ledger.append(record(1, intent)), second.ledger.append(record(1, intent, "other"))],
		]) {
			const statuses = (await Promise.allSettled(write())).map(result => result.status).sort();
			expect(statuses).toEqual(["fulfilled", "rejected"]);
		}
		expect((await first.sessionStore.load("s"))?.entries).toEqual([entry()]);
		expect(await first.sessionStore.load("other")).toBeNull();
		expect(await first.ledger.query("other")).toEqual([]);
		first.close(); second.close();
	});

	test("two handles share run sequence allocation and roll back the losing execution index", async () => {
		const { open } = fixture(); const first = await open(); const second = await open();
		const outcomes = await Promise.allSettled([
			first.ledger.append(record(5, { ...execution, toolCallId: "accepted" })),
			second.ledger.append(record(5, { ...execution, toolCallId: "rejected" })),
		]);
		expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
		expect(await first.ledger.hasExecuted("accepted")).toBe(true);
		expect(await first.ledger.getToolExecution("rejected")).toBeNull();
		await expect(second.ledger.append(record(4, { kind: "cancellation" }))).rejects.toThrow();
		await second.ledger.append(record(9, { kind: "terminal", status: "completed" }));
		expect((await first.ledger.query("run")).map(value => value.seq)).toEqual([5, 9]);
		await first.sessionStore.append("s", entry()); await second.sessionStore.append("other", entry());
		expect((await first.sessionStore.load("other"))?.entries).toEqual([entry()]);
		first.close(); second.close();
	});

	test("failed writes roll back metadata, sequence and global execution indexes", async () => {
		const { open } = fixture(); const bundle = await open();
		await bundle.ledger.append(record(5, { kind: "tool_exec", toolCallId: "existing", tool: "edit", argsDigest: "d", outcome: "failure", messageDigest: "m" }));
		await expect(bundle.ledger.append(record(5, execution))).rejects.toThrow();
		expect(await bundle.ledger.hasExecuted("call")).toBe(false);
		expect(await bundle.ledger.getToolExecution("call")).toBeNull();
		await bundle.ledger.append(record(6, execution));
		expect(await bundle.ledger.hasExecuted("call")).toBe(true);
		await bundle.sessionStore.saveCheckpoint(checkpoint());
		await expect(bundle.sessionStore.saveCheckpoint(checkpoint({ sessionId: "rejected" }))).rejects.toThrow();
		expect(await bundle.sessionStore.load("rejected")).toBeNull();
		await bundle.sessionStore.append("rejected", entry());
		expect((await bundle.sessionStore.load("rejected"))?.entries).toEqual([entry()]);
		bundle.close();
	});

	test("request success does not resolve an append before a later transaction abort", async () => {
		const { open } = fixture(); const bundle = await open();
		const add = FakeObjectStore.prototype.add;
		const injection = spyOn(FakeObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
			const operation = add.call(this, value, key);
			if (this.name === "entries") operation.addEventListener("success", () => this.transaction.abort());
			return operation;
		});
		try { await expect(bundle.sessionStore.append("s", entry())).rejects.toThrow(); }
		finally { injection.mockRestore(); }
		expect(await bundle.sessionStore.load("s")).toBeNull();
		await bundle.sessionStore.append("s", entry());
		expect((await bundle.sessionStore.load("s"))?.entries).toEqual([entry()]);
		bundle.close();
	});

	test("validates checkpoint parents, boundaries, digest and additive project schema", async () => {
		const { open } = fixture(); const bundle = await open();
		for (const changes of [
			{ parentId: "missing" }, { entrySeq: 1 }, { contextDigest: "" }, { projectRevision: -1 },
			{ projectId: "" }, { projectCheckpointId: "" }, { runId: "" }, { seq: 0 }, { extra: "private" },
		]) await expect(bundle.sessionStore.saveCheckpoint(checkpoint(changes))).rejects.toThrow();
		expect(await bundle.sessionStore.load("s")).toBeNull();
		await bundle.sessionStore.append("s", entry());
		await bundle.sessionStore.saveCheckpoint(checkpoint({ entrySeq: 1 }));
		await expect(bundle.sessionStore.saveCheckpoint(checkpoint({ checkpointId: "child", parentId: "root", entrySeq: 0 }))).rejects.toThrow();
		await expect(bundle.sessionStore.saveCheckpoint(checkpoint({ checkpointId: "child", sessionId: "other", parentId: "root" }))).rejects.toThrow();
		expect(await bundle.sessionStore.load("other")).toBeNull();
		bundle.close();
	});

	test("lookup is global, success is preferred over later failure, and unknown IDs are empty", async () => {
		const { open } = fixture(); const bundle = await open();
		expect(await bundle.sessionStore.load("missing")).toBeNull();
		expect(await bundle.sessionStore.listCheckpoints("missing")).toEqual([]);
		expect(await bundle.artifactStore.get("missing")).toBeNull();
		expect(await bundle.artifactStore.list("missing")).toEqual([]);
		expect(await bundle.ledger.query("missing")).toEqual([]);
		expect(await bundle.ledger.getToolExecution("missing")).toBeNull();
		await bundle.ledger.append(record(10, intent));
		expect(await bundle.ledger.getToolExecution("call")).toEqual(record(10, intent));
		await bundle.ledger.append(record(1, execution, "other"));
		await bundle.ledger.append(record(11, { ...execution, outcome: "failure" }));
		expect(await bundle.ledger.getToolExecution("call")).toEqual(record(1, execution, "other"));
		expect(await bundle.ledger.hasExecuted("call")).toBe(true);
		bundle.close();
	});

	test("latest intent supersedes an older legacy failure but never a successful execution", async () => {
		const { open } = fixture(); const bundle = await open();
		await bundle.ledger.append(record(1, { ...execution, outcome: "failure" }));
		await bundle.ledger.append(record(2, intent, "other"));
		expect(await bundle.ledger.getToolExecution("call")).toEqual(record(2, intent, "other"));
		await expect(bundle.ledger.append(record(3, intent))).rejects.toThrow();
		await bundle.ledger.append(record(3, execution));
		expect(await bundle.ledger.getToolExecution("call")).toEqual(record(3, execution));
		bundle.close();
	});

	test("rejects invalid schemas and identifiers without consuming IDs or calling accessors", async () => {
		const { open } = fixture(); const bundle = await open(); let reads = 0;
		const accessor = Object.defineProperty(checkpoint(), "entrySeq", { enumerable: true, get() { reads++; return 0; } });
		await expect(bundle.sessionStore.saveCheckpoint(accessor)).rejects.toThrow();
		await expect(bundle.sessionStore.append("s", { ...entry(), extra: "secret" } as unknown as AgentSessionEntry)).rejects.toThrow();
		await expect(bundle.artifactStore.put(artifact({ value: { invalid: Infinity } }))).rejects.toThrow();
		await expect(bundle.ledger.append({ ...record(1, intent), extra: "secret" } as LedgerRecord)).rejects.toThrow();
		expect(reads).toBe(0);
		expect(await bundle.sessionStore.load("s")).toBeNull();
		await bundle.sessionStore.append("s", entry()); await bundle.artifactStore.put(artifact()); await bundle.ledger.append(record(1, intent));
		for (const action of [() => bundle.sessionStore.load(""), () => bundle.sessionStore.listCheckpoints(""), () => bundle.artifactStore.get(""), () => bundle.artifactStore.list(""), () => bundle.ledger.query(""), () => bundle.ledger.hasExecuted(""), () => bundle.ledger.getToolExecution("")]) await expect(action()).rejects.toThrow();
		bundle.close();
	});

	test("quota abort rolls back a staged intent claim and run sequence", async () => {
		const { open } = fixture(); const bundle = await open();
		const add = FakeObjectStore.prototype.add;
		const failure = new DOMException("storage full", "QuotaExceededError");
		const injection = spyOn(FakeObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
			if (this.name === "ledger") throw failure;
			return add.call(this, value, key);
		});
		try { await expect(bundle.ledger.append(record(10, intent))).rejects.toThrow("storage full"); }
		finally { injection.mockRestore(); }
		expect(await bundle.ledger.query("run")).toEqual([]);
		expect(await bundle.ledger.getToolExecution("call")).toBeNull();
		await bundle.ledger.append(record(1, intent));
		expect(await bundle.ledger.getToolExecution("call")).toEqual(record(1, intent));
		bundle.close();
	});

	test("query errors reject rather than return an empty volatile result", async () => {
		const { open } = fixture(); const bundle = await open();
		await bundle.sessionStore.append("s", entry());
		const injection = spyOn(FakeIndex.prototype, "getAll").mockImplementation(() => { throw new DOMException("query failed", "UnknownError"); });
		try { await expect(bundle.sessionStore.load("s")).rejects.toThrow("query failed"); }
		finally { injection.mockRestore(); }
		expect((await bundle.sessionStore.load("s"))?.entries).toEqual([entry()]);
		bundle.close();
	});

	test("open and schema migration failures reject without creating an in-memory bundle", async () => {
		const { indexedDB, open } = fixture();
		const injection = spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
		try { await expect(open()).rejects.toThrow("denied"); }
		finally { injection.mockRestore(); }
		const migration = spyOn(FakeDatabase.prototype, "createObjectStore").mockImplementation(() => { throw new DOMException("migration failed", "UnknownError"); });
		try { await expect(open()).rejects.toThrow("migration failed"); }
		finally { migration.mockRestore(); }
		const bundle = await open(); expect(await bundle.sessionStore.load("s")).toBeNull(); bundle.close();
	});

	test("blocked opening rejects and does not expose a fallback bundle", async () => {
		const { indexedDB, open } = fixture(); const original = indexedDB.open.bind(indexedDB);
		const injection = spyOn(indexedDB, "open").mockImplementation((name: string, version?: number) => {
			const opening = original(name, version);
			queueMicrotask(() => opening.onblocked?.call(opening, Object.assign(new Event("blocked"), {oldVersion:0,newVersion:1})));
			return opening;
		});
		try { await expect(open()).rejects.toThrow("blocked"); }
		finally { injection.mockRestore(); }
		const bundle = await open(); bundle.close();
	});

	test("an incompatible persisted schema rejects rather than silently resetting it", async () => {
		const { indexedDB, open } = fixture();
		const deferred = Promise.withResolvers<IDBDatabase>();
		const opening = indexedDB.open("isolated", 1);
		opening.onupgradeneeded = () => opening.result.createObjectStore("unrelated");
		opening.onsuccess = () => deferred.resolve(opening.result);
		opening.onerror = () => deferred.reject(opening.error);
		const database = await deferred.promise; database.close();
		await expect(open()).rejects.toThrow("schema");
	});

	test("closing is idempotent and rejects every later read and write instead of falling back", async () => {
		const { open } = fixture(); const bundle = await open(); bundle.close(); bundle.close();
		for (const action of [
			() => bundle.sessionStore.load("s"), () => bundle.sessionStore.append("s", entry()), () => bundle.sessionStore.listCheckpoints("s"), () => bundle.sessionStore.saveCheckpoint(checkpoint()),
			() => bundle.artifactStore.put(artifact()), () => bundle.artifactStore.get("artifact"), () => bundle.artifactStore.list("s"),
			() => bundle.ledger.append(record(1, intent)), () => bundle.ledger.query("run"), () => bundle.ledger.hasExecuted("call"), () => bundle.ledger.getToolExecution("call"),
		]) await expect(action()).rejects.toThrow();
		const reopened = await open(); expect(await reopened.sessionStore.load("s")).toBeNull(); reopened.close();
	});
});
