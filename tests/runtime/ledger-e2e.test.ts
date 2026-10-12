import { expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import type { AgentRuntimeConfig } from "../../src/runtime/contracts";
import { InMemorySessionStore } from "../../src/store/session-store";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { computeContextDigest } from "../../src/store/checkpoint";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentRuntimeEvent } from "../../src/events";
import type { AgentMessage, StreamChunk, ToolCall } from "../../src/types";
import type { AgentSessionEntry } from "../../src/store/entries";

async function collect(stream: AsyncGenerator<AgentRuntimeEvent>) {
	const events: AgentRuntimeEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
function config(model: string): AgentRuntimeConfig {
	return { sessionId: model, sessionStore: new InMemorySessionStore(), artifactStore: new InMemoryArtifactStore(), ledger: new InMemoryLedger(),
		llmConfig: { model, baseUrl: "https://ledger.invalid", apiKey: "never-persist-this" }, expertRoleId: "general", tools: [] };
}
const toolCall: ToolCall = { id: "repair-call", type: "function", function: { name: "edit", arguments: "{}" } };
async function seedPending(c: AgentRuntimeConfig) {
	const messages: AgentMessage[] = [{ id: "user", role: "user", content: "edit", createdAt: 0 },
		{ id: "assistant", role: "assistant", content: "", toolCalls: [toolCall], createdAt: 0 }];
	const entries: AgentSessionEntry[] = [{ kind: "run_started", id: "start", ts: 0, runId: "crash" },
		{ kind: "user_message", id: "user", ts: 0, content: "edit" },
		{ kind: "assistant_message", id: "assistant", ts: 0, content: "", toolCalls: [toolCall] },
		{ kind: "run_state", id: "cursor", ts: 0, runId: "crash", seq: 5, iteration: 0, phase: "tools", activeRoleId: "general", checkpointId: "boundary" }];
	for (const entry of entries) await c.sessionStore.append(c.sessionId, entry);
	await c.sessionStore.saveCheckpoint({ checkpointId: "boundary", sessionId: c.sessionId, createdAt: 0, entrySeq: 3,
		contextDigest: computeContextDigest(messages), runId: "crash", seq: 4 });
	return computeContextDigest([{ id: "digest", role: "assistant", content: "", toolCalls: [toolCall], createdAt: 0 }]);
}

test("ledger committed result repairs missing session result without executing the tool", async () => {
	const c = config("repair");
	const argsDigest = await seedPending(c);
	await c.artifactStore!.put({ artifactId: "result", sessionId: c.sessionId, contentType: "application/json", value: { success: true, message: "edited" } });
	await c.ledger!.append({ runId: "crash", seq: 20, ts: 0, event: { kind: "tool_exec", toolCallId: toolCall.id,
		tool: "edit", argsDigest, outcome: "success", messageDigest: "message", artifactId: "result" } });
	let executions = 0;
	const dispose = registerLLMBackendFor(x => x === c.llmConfig, { type: "repair", async *streamChat(_config, messages): AsyncGenerator<StreamChunk> {
		expect(messages.some(message => message.role === "tool")).toBe(true); yield { type: "done" };
	} });
	try {
		const events = await collect(createAgentRuntime({ ...c, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
			execute: async () => { executions++; return { success: true, message: "duplicate" }; } }] }).resume("crash"));
		expect(executions).toBe(0);
		expect(events.at(-1)?.type).toBe("run_completed");
		expect((await c.sessionStore.load(c.sessionId))?.entries.filter(entry => entry.kind === "tool_result")).toHaveLength(1);
	} finally { dispose(); }
});

test("uncertain non-idempotent intent cannot be blindly replayed", async () => {
	const c = config("uncertain");
	const argsDigest = await seedPending(c);
	await c.ledger!.append({ runId: "crash", seq: 10, ts: 0, event: { kind: "tool_intent", toolCallId: toolCall.id, tool: "edit", argsDigest } });
	let executions = 0;
	let requests = 0;
	const dispose = registerLLMBackendFor(x => x === c.llmConfig, { type: "uncertain", async *streamChat(): AsyncGenerator<StreamChunk> { requests++; yield { type: "done" }; } });
	try {
		const events = await collect(createAgentRuntime({ ...c, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
			execute: async () => { executions++; return { success: true, message: "duplicate" }; } }] }).resume("crash"));
		expect(events.at(-1)?.type).toBe("run_failed");
		expect(executions).toBe(0);
		expect(requests).toBe(0);
	} finally { dispose(); }
});

test("runtime shares sequence allocator with usage, host command revision and terminal ledger", async () => {
	const c = config("ledger-e2e");
	let requests = 0;
	let revision = 3;
	const dispose = registerLLMBackendFor(x => x === c.llmConfig, { type: "ledger-e2e", async *streamChat(): AsyncGenerator<StreamChunk> {
		if (++requests === 1) yield { type: "tool_calls_complete", toolCalls: [{ ...toolCall, id: "e2e-call" }] };
		yield { type: "done", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } };
	} });
	try {
		const events = await collect(createAgentRuntime({ ...c, hooks: { getProjectFacts: () => ({ projectId: "p", projectRevision: revision, digest: "host", producedBy: "host" }) },
			tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} }, execute: async () => {
				revision++; return { success: true, message: "edited", data: { commandId: "command", projectRevisionBefore: 3, projectRevisionAfter: 4 } };
			} }] }).run("edit"));
		const records = await c.ledger!.query(events[0]!.runId);
		expect(records.filter(record => record.event.kind === "model_call")).toHaveLength(2);
		expect(records.find(record => record.event.kind === "tool_exec")?.event).toMatchObject({ commandId: "command", projectRevisionBefore: 3, projectRevisionAfter: 4 });
		expect(records.at(-1)?.event).toMatchObject({ kind: "terminal", status: "completed" });
		const sequence = [...events.map(event => event.seq), ...records.map(record => record.seq)];
		expect(new Set(sequence).size).toBe(sequence.length);
		expect(JSON.stringify(await c.sessionStore.load(c.sessionId)) + JSON.stringify(records)).not.toContain(c.llmConfig.apiKey);
	} finally { dispose(); }
});

test("confirmed assistant committed before its checkpoint resumes the original pending batch", async () => {
	const c = config("assistant-boundary-crash");
	await c.sessionStore.append(c.sessionId, { kind: "run_started", id: "start", ts: 0, runId: "crash" });
	await c.sessionStore.append(c.sessionId, { kind: "user_message", id: "user", ts: 0, content: "edit" });
	await c.sessionStore.saveCheckpoint({ checkpointId: "before-model", sessionId: c.sessionId, createdAt: 0, entrySeq: 2, runId: "crash", seq: 1,
		contextDigest: computeContextDigest([{ id: "user", createdAt: 0, role: "user", content: "edit" }]) });
	await c.sessionStore.append(c.sessionId, { kind: "run_state", id: "cursor", ts: 0, runId: "crash", seq: 2, iteration: 0,
		phase: "model", activeRoleId: "general", checkpointId: "before-model" });
	await c.sessionStore.append(c.sessionId, { kind: "assistant_message", id: "assistant", ts: 0, content: "", toolCalls: [toolCall] });
	let executions = 0;
	const dispose = registerLLMBackendFor(x => x === c.llmConfig, { type: "assistant-crash", async *streamChat(): AsyncGenerator<StreamChunk> { yield { type: "done" }; } });
	try {
		const events = await collect(createAgentRuntime({ ...c, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
			execute: async () => { executions++; return { success: true, message: "edited" }; } }] }).resume("crash"));
		expect(executions).toBe(1);
		expect(events.at(-1)?.type).toBe("run_completed");
	} finally { dispose(); }
});

test("missing provider usage remains unknown rather than recording zero consumption", async () => {
	const c = config("unknown-usage");
	const dispose = registerLLMBackendFor(x => x === c.llmConfig, { type: "unknown-usage", async *streamChat(): AsyncGenerator<StreamChunk> { yield { type: "done" }; } });
	try {
		const events = await collect(createAgentRuntime(c).run("respond"));
		const records = await c.ledger!.query(events[0]!.runId);
		const model = records.find(record => record.event.kind === "model_call")!.event;
		if (model.kind !== "model_call") throw new Error("Missing model usage record");
		expect(model.usage).toEqual({});
	} finally { dispose(); }
});

test.each(["deny", "suspend"] as const)("committed autoallowed calls replay without reevaluating a now-%s policy", async action => {
	const c = config(`cached-policy-${action}`);
	const argsDigest = await seedPending(c);
	await c.artifactStore!.put({ artifactId: "committed", sessionId: c.sessionId, contentType: "application/json", value: { success: true, message: "already published" } });
	await c.ledger!.append({ runId: "crash", seq: 6, ts: 0, event: { kind: "approval", toolCallId: toolCall.id, decision: "allow" } });
	await c.ledger!.append({ runId: "crash", seq: 20, ts: 0, event: { kind: "tool_exec", toolCallId: toolCall.id, tool: "edit", argsDigest, outcome: "success", messageDigest: "message", artifactId: "committed" } });
	let effects = 0;
	const dispose = registerLLMBackendFor(x => x === c.llmConfig, { type: "cached-policy", async *streamChat(_config, messages) {
		expect(messages.find(message => message.role === "tool")?.content).toBe(JSON.stringify({ success: true, message: "already published" }));
		yield { type: "done" as const };
	} });
	try {
		const events = await collect(createAgentRuntime({ ...c, approval: { preflight: () => ({ action, reason: "Changed policy" }) }, tools: [{ name: "edit", description: "edit", parameters: { type: "object" }, execute: async () => { effects++; return { success: true, message: "duplicate" }; } }] }).resume("crash"));
		expect(events.at(-1)?.type).toBe("run_completed");
		expect(effects).toBe(0);
	} finally { dispose(); }
});
