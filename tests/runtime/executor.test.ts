import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../src/types";
import type { AgentTool } from "../../src/tool-types";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { createToolExecutor } from "../../src/runtime/executor";
import { computeContextDigest } from "../../src/store/checkpoint";

const call = (id = "call-1", args = '{"path":"a"}'): ToolCall => ({ id, type: "function", function: { name: "edit", arguments: args } });
const context = (runId = "run-1") => ({ runId, nextSeq: (() => { let seq = 0; return () => ++seq; })() });
const tool = (execute: AgentTool["execute"], extra: Partial<AgentTool> = {}): AgentTool => ({ name: "edit", description: "edit", parameters: { type: "object" }, execute, ...extra });

describe("ToolExecutor", () => {
	test("executes each tool call once and replays cached success", async () => {
		let calls = 0;
		const ledger = new InMemoryLedger();
		const artifactStore = new InMemoryArtifactStore();
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => { calls++; return { success: true, message: "ok" }; })], ledger, artifactStore });
		expect(await executor.execute(call(), context())).toMatchObject({ success: true });
		expect(await executor.execute(call(), context("run-2"))).toMatchObject({ success: true });
		expect(calls).toBe(1);
	});

	test("returns cached failure without re-executing", async () => {
		let calls = 0;
		const ledger = new InMemoryLedger();
		const artifactStore = new InMemoryArtifactStore();
		const executor = createToolExecutor({ sessionId: "session", tools: [tool(async () => { calls++; return { success: false, message: "no" }; })], ledger, artifactStore });
		expect(await executor.execute(call(), context())).toMatchObject({ success: false, message: "no" });
		expect(await executor.execute(call(), context("run-2"))).toMatchObject({ success: false, message: "no" });
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
		expect(await executor.execute(pending, context("run-2"))).toMatchObject({ success: false });
		expect(calls).toBe(0);
	});
});
