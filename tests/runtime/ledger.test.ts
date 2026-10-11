import { describe, expect, test } from "bun:test";
import { InMemoryLedger } from "../../src/runtime/ledger";
import type { ApprovalDecision, LedgerRecord, RuntimeLedger } from "../../src/runtime/ledger";

const toolEvent = (outcome: "success" | "failure", toolCallId = "call-1"): LedgerRecord["event"] => ({
	kind: "tool_exec", toolCallId, tool: "edit", argsDigest: "args-digest",
	outcome, messageDigest: "message-digest",
});

const record = (seq: number, event: LedgerRecord["event"] = toolEvent("success"), runId = "run-1"): LedgerRecord => ({
	runId, seq, ts: 0, event,
});

const appendUnknown = (ledger: RuntimeLedger, value: unknown) => ledger.append(value as LedgerRecord);

const decisions: ApprovalDecision[] = ["allow", "deny", "suspend"];
const events: LedgerRecord["event"][] = [
	{ kind: "model_call", provider: "custom", model: "model-1", requestIndex: 0, usage: {} },
	{
		kind: "model_call", provider: "openai", model: "model-2", requestIndex: 3,
		usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.02, cacheReadTokens: 4, cacheWriteTokens: 2 },
	},
	toolEvent("success"),
	{
		kind: "tool_exec", toolCallId: "call-2", tool: "edit", argsDigest: "args",
		outcome: "failure", messageDigest: "message", artifactId: "artifact-1",
		commandId: "command-1", projectRevisionBefore: 0, projectRevisionAfter: 1,
	},
	{ kind: "retry", attempt: 0, category: "provider" },
	{ kind: "retry", toolCallId: "call-1", attempt: 1, category: "context_overflow" },
	{ kind: "retry", toolCallId: "call-1", attempt: 2, category: "tool_failure" },
	{ kind: "retry", toolCallId: "call-1", attempt: 3, category: "interrupted" },
	...decisions.map(decision => ({ kind: "approval" as const, toolCallId: "call-1", decision })),
	{ kind: "compaction" },
	{ kind: "compaction", detail: "summary-digest" },
	{ kind: "cancellation" },
	{ kind: "cancellation", detail: "" },
];

describe("InMemoryLedger", () => {
	test("roundtrips every event shape in append order", async () => {
		const ledger: RuntimeLedger = new InMemoryLedger();
		const records = events.map((event, index) => record(index + 1, event));
		for (const item of records) await ledger.append(item);
		expect(await ledger.query("run-1")).toEqual(records);
		expect(await ledger.query("missing-run")).toEqual([]);
	});

	test("only successful executions protect replay, globally across runs", async () => {
		const ledger = new InMemoryLedger();
		expect(await ledger.hasExecuted("call-1")).toBe(false);
		await ledger.append(record(1, toolEvent("failure")));
		await ledger.append(record(2, { kind: "retry", toolCallId: "call-1", attempt: 1, category: "tool_failure" }));
		await ledger.append(record(3, { kind: "approval", toolCallId: "call-1", decision: "allow" }));
		expect(await ledger.hasExecuted("call-1")).toBe(false);
		await ledger.append(record(1, toolEvent("success"), "run-2"));
		expect(await ledger.hasExecuted("call-1")).toBe(true);
		await ledger.append(record(4, toolEvent("failure")));
		await ledger.append(record(2, toolEvent("failure", "call-2"), "run-2"));
		expect(await ledger.hasExecuted("call-1")).toBe(true);
		expect(await ledger.hasExecuted("call-2")).toBe(false);
	});

	test("sequences are independent per run and accept gaps and interleaving", async () => {
		const ledger = new InMemoryLedger();
		const first = record(10, { kind: "compaction" }, "__proto__");
		const second = record(1, { kind: "cancellation" }, "constructor");
		const third = record(50, { kind: "compaction", detail: "next" }, "__proto__");
		const fourth = record(3, { kind: "cancellation", detail: "next" }, "constructor");
		for (const item of [first, second, third, fourth]) await ledger.append(item);
		expect(await ledger.query("__proto__")).toEqual([first, third]);
		expect(await ledger.query("constructor")).toEqual([second, fourth]);
	});

	test.each([5, 4, 1])("rejects duplicate or backwards seq %i without mutating history or success index", async seq => {
		const ledger = new InMemoryLedger();
		const first = record(5, toolEvent("failure", "first"));
		await ledger.append(first);
		await expect(ledger.append(record(seq, toolEvent("success", "rejected")))).rejects.toThrow();
		expect(await ledger.query("run-1")).toEqual([first]);
		expect(await ledger.hasExecuted("rejected")).toBe(false);
		const next = record(6, toolEvent("success", "rejected"));
		await ledger.append(next);
		expect(await ledger.query("run-1")).toEqual([first, next]);
		expect(await ledger.hasExecuted("rejected")).toBe(true);
	});

	test("concurrent duplicate appends commit exactly one history and index update", async () => {
		const ledger = new InMemoryLedger();
		const results = await Promise.allSettled([
			ledger.append(record(1, toolEvent("success", "accepted"))),
			ledger.append(record(1, toolEvent("success", "rejected"))),
		]);
		expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
		expect(await ledger.query("run-1")).toHaveLength(1);
		expect(await ledger.hasExecuted("accepted")).toBe(true);
		expect(await ledger.hasExecuted("rejected")).toBe(false);
	});

	test("append and query isolate nested usage and prior query snapshots", async () => {
		const ledger = new InMemoryLedger();
		const event: LedgerRecord["event"] = {
			kind: "model_call", provider: "custom", model: "model-1", requestIndex: 0,
			usage: { totalTokens: 15, cost: 0.02 },
		};
		const original = record(1, event);
		await ledger.append(original);
		event.usage.totalTokens = 999;
		event.usage.cost = 100;
		const snapshot = await ledger.query("run-1");
		const returnedEvent = snapshot[0]!.event;
		if (returnedEvent.kind !== "model_call") throw new Error("Expected model call");
		expect(returnedEvent.usage).toEqual({ totalTokens: 15, cost: 0.02 });
		returnedEvent.usage.totalTokens = 500;
		snapshot.push(record(100));
		expect(await ledger.query("run-1")).toEqual([
			record(1, { ...event, usage: { totalTokens: 15, cost: 0.02 } }),
		]);
		await ledger.append(record(2, { kind: "cancellation" }));
		expect(snapshot.map(item => item.seq)).toEqual([1, 100]);
	});

	test("caller mutation cannot alter the success index or stored tool fields", async () => {
		const ledger = new InMemoryLedger();
		const event = toolEvent("success", "original");
		await ledger.append(record(1, event));
		if (event.kind !== "tool_exec") throw new Error("Expected tool execution");
		event.toolCallId = "changed";
		event.outcome = "failure";
		const queried = await ledger.query("run-1");
		const returnedEvent = queried[0]!.event;
		if (returnedEvent.kind !== "tool_exec") throw new Error("Expected tool execution");
		returnedEvent.toolCallId = "changed-again";
		expect(await ledger.hasExecuted("original")).toBe(true);
		expect(await ledger.hasExecuted("changed")).toBe(false);
		expect(await ledger.query("run-1")).toEqual([record(1, toolEvent("success", "original"))]);
	});

	test.each(["apiKey", "cookie", "rawArgs", "prompt", "unexpected"])("rejects unknown %s fields at every schema level", async field => {
		const ledger = new InMemoryLedger();
		const model = events[0]!;
		for (const value of [
			{ ...record(1), [field]: "secret" },
			{ ...record(1), [field]: undefined },
			record(1, { ...toolEvent("success"), [field]: "secret" } as LedgerRecord["event"]),
			record(1, { ...model, [field]: "secret" } as LedgerRecord["event"]),
			record(1, { ...model, usage: { [field]: "secret" } } as LedgerRecord["event"]),
			...events.map(event => ({ ...record(1), event: { ...event, [field]: "secret" } })),
		]) {
			await expect(appendUnknown(ledger, value)).rejects.toThrow();
		}
		expect(await ledger.query("run-1")).toEqual([]);
		expect(await ledger.hasExecuted("call-1")).toBe(false);
	});

	test.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid seq %s atomically", async seq => {
		const ledger = new InMemoryLedger();
		await expect(ledger.append(record(seq))).rejects.toThrow();
		expect(await ledger.query("run-1")).toEqual([]);
		expect(await ledger.hasExecuted("call-1")).toBe(false);
		await ledger.append(record(1));
		expect(await ledger.query("run-1")).toHaveLength(1);
	});

	test.each([-1, Number.NaN, Infinity, -Infinity])("rejects invalid timestamp %s", async ts => {
		await expect(appendUnknown(new InMemoryLedger(), { ...record(1), ts })).rejects.toThrow();
	});

	test("timestamps and provider-reported usage accept nonnegative finite values", async () => {
		const ledger = new InMemoryLedger();
		const item: LedgerRecord = { ...record(1), ts: 0.5, event: {
			kind: "model_call", provider: "custom", model: "model", requestIndex: 0,
			usage: { promptTokens: 0.5, completionTokens: 0, totalTokens: 0.5, cost: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		} };
		await ledger.append(item);
		expect(await ledger.query("run-1")).toEqual([item]);
	});

	test("accepts safe integer boundaries for sequence, indexes and revisions", async () => {
		const ledger = new InMemoryLedger();
		const maximum = Number.MAX_SAFE_INTEGER;
		const items = [
			record(1, { kind: "model_call", provider: "custom", model: "model", requestIndex: maximum, usage: {} }),
			record(2, { kind: "retry", attempt: maximum, category: "provider" }),
			record(maximum, { ...toolEvent("success"), projectRevisionBefore: 0, projectRevisionAfter: maximum } as LedgerRecord["event"]),
		];
		for (const item of items) await ledger.append(item);
		expect(await ledger.query("run-1")).toEqual(items);
	});

	test.each(["promptTokens", "completionTokens", "totalTokens", "cost", "cacheReadTokens", "cacheWriteTokens"])("rejects invalid usage %s", async field => {
		for (const value of [-1, Number.NaN, Infinity, -Infinity, "1", null]) {
			const event = { kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: { [field]: value } };
			await expect(appendUnknown(new InMemoryLedger(), { ...record(1), event })).rejects.toThrow();
		}
	});

	test.each(["projectRevisionBefore", "projectRevisionAfter"])("rejects invalid revision %s", async field => {
		for (const value of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
			await expect(appendUnknown(new InMemoryLedger(), { ...record(1), event: { ...toolEvent("success"), [field]: value } })).rejects.toThrow();
		}
	});

	test("rejects malformed event discriminants, identifiers and counts", async () => {
		const invalidEvents = [
			null, [], {}, { kind: "unknown" },
			{ kind: "compaction", detail: 1 }, { kind: "cancellation", detail: null },
			{ kind: "approval", toolCallId: "call", decision: "approved" },
			{ kind: "approval", toolCallId: "", decision: "allow" },
			{ kind: "retry", attempt: 1, category: "unknown" },
			{ kind: "retry", attempt: 1, category: "provider", toolCallId: "" },
			...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].flatMap(value => [
				{ kind: "retry", attempt: value, category: "provider" },
				{ kind: "model_call", provider: "custom", model: "model", requestIndex: value, usage: {} },
			]),
			...(["provider", "model"] as const).map(field => ({
				kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: {}, [field]: "",
			})),
			...["toolCallId", "tool", "argsDigest", "messageDigest", "artifactId", "commandId"].flatMap(field => [
				{ ...toolEvent("success"), [field]: "" }, { ...toolEvent("success"), [field]: 1 },
			]),
			{ ...toolEvent("success"), outcome: "pending" },
			{ kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: [] },
		];
		for (const event of invalidEvents) {
			await expect(appendUnknown(new InMemoryLedger(), { ...record(1), event })).rejects.toThrow();
		}
		for (const value of [null, [], {}, { ...record(1), runId: "" }, { ...record(1), runId: 1 }]) {
			await expect(appendUnknown(new InMemoryLedger(), value)).rejects.toThrow();
		}
	});

	test("synthetic metadata without an own field cannot create a replay marker", async () => {
		const ledger = new InMemoryLedger();
		const missingRun = new Proxy({ seq: 1, ts: 0, event: toolEvent("success", "synthetic-call") }, {
			get(target, key, receiver) { return key === "runId" ? "synthetic-run" : Reflect.get(target, key, receiver); },
		});
		await expect(appendUnknown(ledger, missingRun)).rejects.toThrow();
		expect(await ledger.hasExecuted("synthetic-call")).toBe(false);
	});

	test("synthetic valid sequence cannot commit an invalid own sequence", async () => {
		const ledger = new InMemoryLedger();
		const item = new Proxy(record(0, toolEvent("success", "forged")), {
			get(target, key, receiver) { return key === "seq" ? 1 : Reflect.get(target, key, receiver); },
		});
		await expect(ledger.append(item)).rejects.toThrow();
		expect(await ledger.query("run-1")).toEqual([]);
		expect(await ledger.hasExecuted("forged")).toBe(false);
	});

	test("rejects unsupported JSON even when a known optional field would serialize away", async () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const detail of [cycle, 1n, () => "secret", Symbol("secret"), new Date(), new Uint8Array([1])]) {
			await expect(appendUnknown(new InMemoryLedger(), { ...record(1), event: { kind: "compaction", detail } })).rejects.toThrow();
		}
		const unusualEvent = Object.assign(Object.create({ inherited: true }), toolEvent("success"));
		await expect(appendUnknown(new InMemoryLedger(), { ...record(1), event: unusualEvent })).rejects.toThrow();
	});

	test("optional undefined fields omit through JSON copies", async () => {
		const ledger = new InMemoryLedger();
		await ledger.append(record(1, { kind: "compaction", detail: undefined }));
		await ledger.append(record(2, { kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: { cost: undefined } }));
		expect(await ledger.query("run-1")).toEqual([
			record(1, { kind: "compaction" }),
			record(2, { kind: "model_call", provider: "custom", model: "model", requestIndex: 0, usage: {} }),
		]);
	});

	test("query identifiers and replay lookup identifiers must be nonempty strings", async () => {
		const ledger = new InMemoryLedger();
		await expect(ledger.query("")).rejects.toThrow();
		await expect(ledger.hasExecuted("")).rejects.toThrow();
	});
});
