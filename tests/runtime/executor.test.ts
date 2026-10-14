import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../src/types";
import type { AgentTool, DurableAgentTool } from "../../src/tool-types";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { ApprovalRequiredError, createToolExecutor } from "../../src/runtime/executor";
import type { ToolExecutorContext } from "../../src/runtime/executor";
import { computeContextDigest } from "../../src/store/checkpoint";

const call = (id = "call-1", args = '{"path":"a"}', name = "edit"): ToolCall => ({ id, type: "function", function: { name, arguments: args } });
const context = (runId = "run-1", extra: Omit<Partial<ToolExecutorContext>, "runId" | "nextSeq"> = {}) => ({ runId, nextSeq: (() => { let seq = 0; return () => ++seq; })(), ...extra });
const tool = (execute: AgentTool["execute"], extra: Partial<AgentTool> = {}): DurableAgentTool => ({ name: "edit", description: "edit", parameters: { type: "object" }, ...extra, execute: async args => ({ result: await execute(args) }) });
const deferred = <T>() => Promise.withResolvers<T>();

describe("ToolExecutor", () => {
	test("executes each tool call once and replays cached success", async () => {
		let calls = 0;
		const ledger = new InMemoryLedger();
		const artifactStore = new InMemoryArtifactStore();
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => { calls++; return { success: true, message: "ok" }; })], ledger, artifactStore });
		expect(await executor.execute(call(), context())).toMatchObject({ success: true });
		expect(await executor.execute(call(), context())).toMatchObject({ success: true });
		expect(calls).toBe(1);
	});

	test("returns cached failure without re-executing", async () => {
		let calls = 0;
		const ledger = new InMemoryLedger();
		const artifactStore = new InMemoryArtifactStore();
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => { calls++; return { success: false, message: "no" }; })], ledger, artifactStore });
		expect(await executor.execute(call(), context())).toMatchObject({ success: false, message: "no" });
		expect(await executor.execute(call(), context())).toMatchObject({ success: false, message: "no" });
		expect(calls).toBe(1);
	});

	test("blocks changed arguments for an existing call id", async () => {
		const ledger = new InMemoryLedger();
		const artifactStore = new InMemoryArtifactStore();
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => ({ success: true, message: "ok" }))], ledger, artifactStore });
		await executor.execute(call(), context());
		await expect(executor.execute(call("call-1", '{"path":"b"}'), context("run-2"))).rejects.toMatchObject({ category: "tool_failure" });
	});

	test("does not execute an uncertain non-idempotent intent", async () => {
		const ledger = new InMemoryLedger();
		await ledger.append({ runId: "old", seq: 1, ts: 0, event: { kind: "tool_intent", toolCallId: "call-1", tool: "edit", argsDigest: "00000000" } });
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => ({ success: true, message: "bad" }))], ledger, artifactStore: new InMemoryArtifactStore() });
		await expect(executor.execute(call(), context("run-2"))).rejects.toMatchObject({ category: "tool_failure" });
	});
	test("does not reattempt an uncertain intent after approval becomes required", async () => {
		const pending = call();
		const ledger = new InMemoryLedger();
		await ledger.append({ runId: "old", seq: 1, ts: 0, event: { kind: "tool_intent", toolCallId: pending.id, tool: "edit", argsDigest: computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [pending] }]) } });
		let calls = 0;
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => { calls++; return { success: true, message: "bad" }; }, { annotations: { readOnly: true, requiresApproval: true } })], ledger, artifactStore: new InMemoryArtifactStore() });
		await expect(executor.execute(pending, context("run-2"))).rejects.toMatchObject({ category: "tool_failure" });
		expect(calls).toBe(0);
	});
	test("runs adjacent parallel reads together, preserves result order, and keeps writes isolated", async () => {
		const firstRead = deferred<{ success: boolean; message: string }>();
		const secondRead = deferred<{ success: boolean; message: string }>();
		const readsStarted = deferred<void>();
		const events: string[] = [];
		let readStarts = 0;
		const executor = createToolExecutor({ sessionId: "session", executor: { parallelReadOnly: true }, ledger: new InMemoryLedger(), artifactStore: new InMemoryArtifactStore(), tools: [
			tool(async () => { events.push("write-start", "write-end"); return { success: true, message: "write" }; }, { name: "write" }),
			tool(async () => { events.push("read-a-start"); readStarts++; if (readStarts === 2) readsStarted.resolve(); return firstRead.promise; }, { name: "read-a", annotations: { readOnly: true, executionMode: "parallel" } }),
			tool(async () => { events.push("read-b-start"); readStarts++; if (readStarts === 2) readsStarted.resolve(); return secondRead.promise; }, { name: "read-b", annotations: { readOnly: true, executionMode: "parallel" } }),
		] });
		const batch = executor.executeBatch([call("write-before", "{}", "write"), call("read-a", "{}", "read-a"), call("read-b", "{}", "read-b"), call("write-after", "{}", "write")], context());
		await readsStarted.promise;
		expect(events).toEqual(["write-start", "write-end", "read-a-start", "read-b-start"]);
		secondRead.resolve({ success: true, message: "second" });
		firstRead.resolve({ success: true, message: "first" });
		expect((await batch).map(result => result.message)).toEqual(["write", "first", "second", "write"]);
		expect(events).toEqual(["write-start", "write-end", "read-a-start", "read-b-start", "write-start", "write-end"]);
	});

	test("schedules undo by its annotations, not its name", async () => {
		const before = deferred<{ success: boolean; message: string }>();
		const undo = deferred<{ success: boolean; message: string }>();
		const beforeStarted = deferred<void>();
		const undoStarted = deferred<void>();
		const executor = createToolExecutor({ sessionId: "session", executor: { parallelReadOnly: true }, ledger: new InMemoryLedger(), artifactStore: new InMemoryArtifactStore(), tools: [
			tool(async () => { beforeStarted.resolve(); return before.promise; }, { name: "read-before", annotations: { readOnly: true, executionMode: "parallel" } }),
			tool(async () => { undoStarted.resolve(); return undo.promise; }, { name: "undo", annotations: { readOnly: true, executionMode: "parallel" } }),
		] });
		const batch = executor.executeBatch([call("before", "{}", "read-before"), call("undo", "{}", "undo")], context());
		await Promise.all([beforeStarted.promise, undoStarted.promise]);
		undo.resolve({ success: true, message: "undone" });
		before.resolve({ success: true, message: "before" });
		expect((await batch).map(result => result.message)).toEqual(["before", "undone"]);
	});

	test("settles every parallel read when one provider read fails and propagates storage faults", async () => {
		const sibling = deferred<{ success: boolean; message: string }>();
		const siblingStarted = deferred<void>();
		const executor = createToolExecutor({ sessionId: "session", executor: { parallelReadOnly: true }, ledger: new InMemoryLedger(), artifactStore: new InMemoryArtifactStore(), tools: [
			tool(async () => { throw new Error("read failed"); }, { name: "fails", annotations: { readOnly: true, executionMode: "parallel" } }),
			tool(async () => { siblingStarted.resolve(); return sibling.promise; }, { name: "sibling", annotations: { readOnly: true, executionMode: "parallel" } }),
		] });
		const batch = executor.executeBatch([call("fails", "{}", "fails"), call("sibling", "{}", "sibling")], context());
		await siblingStarted.promise;
		sibling.resolve({ success: true, message: "sibling" });
		expect((await batch).map(result => result.success)).toEqual([false, true]);

		const baseStore = new InMemoryArtifactStore();
		const brokenStore = { get: baseStore.get.bind(baseStore), list: baseStore.list.bind(baseStore), put: async () => { throw new Error("storage unavailable"); } };
		const storageExecutor = createToolExecutor({ sessionId: "storage", ledger: new InMemoryLedger(), artifactStore: brokenStore, tools: [tool(async () => ({ success: true, message: "read" }), { annotations: { readOnly: true, executionMode: "parallel" } })] });
		await expect(storageExecutor.executeBatch([call("storage-fault")], context())).rejects.toThrow("storage unavailable");
	});

	test("preflights before intents or effects and exposes structured suspension", async () => {
		let effects = 0;
		const calls: ToolCall[] = [];
		const ledger = new InMemoryLedger();
		const executor = createToolExecutor({ sessionId: "session", ledger, artifactStore: new InMemoryArtifactStore(), approval: { async preflight(input) {
			calls.push(input.toolCall);
			expect(input).toMatchObject({ runId: "run-1", externalStateBinding: { scopeId: "project", version: "4" }, annotations: { requiresApproval: true } });
			return { action: "suspend", reason: "review" };
		} }, tools: [tool(async () => { effects++; return { success: true, message: "unsafe" }; }, { annotations: { requiresApproval: true } })] });
		const pending = call("needs-review");
		await expect(executor.executeBatch([pending], context("run-1", { getHostSnapshot: () => ({ externalStateBinding: { scopeId: "project", version: "4" } }) }))).rejects.toBeInstanceOf(ApprovalRequiredError);
		expect(effects).toBe(0);
		expect((await ledger.query("run-1")).some(record => record.event.kind === "tool_intent")).toBe(false);
		await expect(executor.execute(pending, context("run-1", { getHostSnapshot: () => ({ externalStateBinding: { scopeId: "project", version: "4" } }) }))).rejects.toBeInstanceOf(ApprovalRequiredError);
		expect(calls).toHaveLength(2);
	});
	test("returns only the completed serial prefix after cancellation", async () => {
		const controller = new AbortController();
		let secondStarted = false;
		const executor = createToolExecutor({ sessionId: "session", ledger: new InMemoryLedger(), artifactStore: new InMemoryArtifactStore(), tools: [
			tool(async () => { controller.abort(); return { success: true, message: "first" }; }, { name: "first" }),
			tool(async () => { secondStarted = true; return { success: true, message: "second" }; }, { name: "second" }),
		] });
		const results = await executor.executeBatch([call("first", "{}", "first"), call("second", "{}", "second")], context("run-1", { signal: controller.signal }));
		expect(results).toEqual([{ success: true, message: "first" }]);
		expect(secondStarted).toBe(false);
	});

	test("honors only exact durable approvals and returns deterministic denied results", async () => {
		let effects = 0;
		const ledger = new InMemoryLedger();
		const executor = createToolExecutor({ sessionId: "session", ledger, artifactStore: new InMemoryArtifactStore(), approval: { preflight: () => { throw new Error("unexpected gate call"); } }, tools: [
			tool(async () => { effects++; return { success: true, message: "published" }; }, { name: "publish", annotations: { destructive: true } }),
		] });
		const results = await executor.executeBatch([call("allowed", "{}", "publish"), call("denied", "{}", "publish")], context("run-1", { approvalDecisions: { allowed: "allow", denied: "deny" } }));
		expect(results).toEqual([{ success: true, message: "published" }, { success: false, message: "approval_denied" }]);
		expect(effects).toBe(1);
		expect((await ledger.query("run-1")).filter(record => record.event.kind === "tool_intent")).toHaveLength(1);
	});

	test("preserves the global intent claim when executors race on the same call", async () => {
		let effects = 0;
		const ledger = new InMemoryLedger();
		const artifactStore = new InMemoryArtifactStore();
		const options = { sessionId: "session", ledger, artifactStore, tools: [tool(async () => { effects++; return { success: true, message: "ok" }; })] };
		const first = createToolExecutor(options);
		const second = createToolExecutor(options);
		const settled = await Promise.allSettled([first.execute(call("global-call"), context("run-one")), second.execute(call("global-call"), context("run-two"))]);
		expect(settled.filter(item => item.status === "fulfilled")).toHaveLength(1);
		expect(settled.filter(item => item.status === "rejected")).toHaveLength(1);
		expect(effects).toBe(1);
		expect((await ledger.query("run-one")).concat(await ledger.query("run-two")).filter(record => record.event.kind === "tool_intent")).toHaveLength(1);
	});
});
