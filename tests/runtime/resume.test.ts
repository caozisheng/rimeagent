import { describe, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import type { AgentRuntimeConfig } from "../../src/runtime/runtime";
import { InMemorySessionStore } from "../../src/store/session-store";
import { computeContextDigest } from "../../src/store/checkpoint";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentRuntimeEvent } from "../../src/events";
import type { ToolCall, StreamChunk } from "../../src/types";
import type { AgentSessionEntry } from "../../src/store/entries";

const call = (id: string): ToolCall => ({ id, type: "function", function: { name: "edit", arguments: "{}" } });
async function collect(stream: AsyncGenerator<AgentRuntimeEvent>) {
	const events: AgentRuntimeEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
async function stopAt(stream: AsyncGenerator<AgentRuntimeEvent>, type: string) {
	let last: AgentRuntimeEvent | undefined;
	while (true) {
		const step = await stream.next();
		if (step.done) throw new Error(`Missing ${type}`);
		last = step.value;
		if (last.type === type) break;
	}
	await stream.return(undefined);
	return last;
}
function setup(model: string): AgentRuntimeConfig {
	return { sessionId: model, sessionStore: new InMemorySessionStore(), ledger: new InMemoryLedger(),
		artifactStore: new InMemoryArtifactStore(), llmConfig: { model, baseUrl: "https://resume.invalid", apiKey: "secret" },
		expertRoleId: "general", tools: [] };
}

describe("durable runtime resume", () => {
	for (const reopen of [false, true]) test(`partial text restarts confirmed history (${reopen ? "new" : "same"} instance)`, async () => {
		const config = setup(`partial-${reopen}`);
		let requests = 0;
		const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "resume", async *streamChat(_config, messages): AsyncGenerator<StreamChunk> {
			requests++;
			expect(JSON.stringify(messages)).not.toContain("discard me");
			yield { type: "content_delta", delta: requests === 1 ? "discard me" : "confirmed" };
			yield { type: "done" };
		} });
		try {
			const runtime = createAgentRuntime(config);
			const interrupted = await stopAt(runtime.run("question"), "text_delta");
			const before = await config.sessionStore.load(config.sessionId);
			const max = Math.max(...(before?.entries.filter(e => e.kind === "run_state").map(e => e.seq) ?? []));
			const resumed = await collect((reopen ? createAgentRuntime(config) : runtime).resume(interrupted.runId));
			expect(resumed.every(e => e.runId === interrupted.runId && e.seq > max)).toBe(true);
			expect(resumed.at(-1)?.type).toBe("run_completed");
			expect(requests).toBe(2);
			expect((await config.sessionStore.load(config.sessionId))?.entries.filter(e => e.kind === "user_message")).toHaveLength(1);
		} finally { dispose(); }
	});

	for (const boundary of ["message_end", "tool_result", "iteration_end"]) test(`two-call batch resumes after ${boundary} without repeating successes`, async () => {
		let executions = 0;
		let requests = 0;
		const config = setup(`batch-${boundary}`);
		const calls = [call(`${boundary}-a`), call(`${boundary}-b`)];
		const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "batch", async *streamChat(): AsyncGenerator<StreamChunk> {
			if (++requests === 1) yield { type: "tool_calls_complete", toolCalls: calls };
			else yield { type: "content_delta", delta: "finished" };
			yield { type: "done" };
		} });
		try {
			const runtime = createAgentRuntime({ ...config, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
				execute: async () => { executions++; return { success: true, message: "ok" }; } }] });
			const interrupted = await stopAt(runtime.run("edit twice"), boundary);
			await collect(runtime.resume(interrupted.runId));
			expect(executions).toBe(2);
			expect(requests).toBe(2);
			expect((await config.sessionStore.load(config.sessionId))?.entries.filter(e => e.kind === "tool_result")).toHaveLength(2);
		} finally { dispose(); }
	});

	test("confirmed final response settles without another model request", async () => {
		const config = setup("confirmed-final");
		let requests = 0;
		const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "final", async *streamChat(): AsyncGenerator<StreamChunk> {
			requests++; yield { type: "content_delta", delta: "answer" }; yield { type: "done" };
		} });
		try {
			const runtime = createAgentRuntime(config);
			const stopped = await stopAt(runtime.run("question"), "message_end");
			const events = await collect(createAgentRuntime(config).resume(stopped.runId));
			expect(events.at(-1)?.payload).toMatchObject({ kind: "run_completed", reason: "response", iterations: 1 });
			expect(requests).toBe(1);
		} finally { dispose(); }
	});

	test("unknown, completed, stale and unfinished new-run validation never appends", async () => {
		const config = setup("invalid-resume");
		const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "invalid", async *streamChat(): AsyncGenerator<StreamChunk> {
			yield { type: "content_delta", delta: "answer" }; yield { type: "done" };
		} });
		try {
			const runtime = createAgentRuntime(config);
			await expect(collect(runtime.resume("unknown"))).rejects.toMatchObject({ category: "tool_failure" });
			expect(await config.sessionStore.load(config.sessionId)).toBeNull();
			const completed = await collect(runtime.run("question"));
			const before = await config.sessionStore.load(config.sessionId);
			await expect(collect(runtime.resume(completed[0]!.runId))).rejects.toMatchObject({ category: "tool_failure" });
			expect(await config.sessionStore.load(config.sessionId)).toEqual(before);
			const stopped = await stopAt(runtime.run("again"), "text_delta");
			const interrupted = await config.sessionStore.load(config.sessionId);
			await expect(collect(runtime.run("hijack"))).rejects.toMatchObject({ category: "tool_failure" });
			expect(await config.sessionStore.load(config.sessionId)).toEqual(interrupted);
			await config.sessionStore.append(config.sessionId, { kind: "run_started", runId: "new-head", id: "new-head", ts: Date.now() });
			const stale = await config.sessionStore.load(config.sessionId);
			await expect(collect(runtime.resume(stopped.runId))).rejects.toMatchObject({ category: "tool_failure" });
			expect(await config.sessionStore.load(config.sessionId)).toEqual(stale);
		} finally { dispose(); }
	});

	for (const mismatch of ["revision", "identity", "digest"]) test(`rejects ${mismatch} mismatch before provider or append`, async () => {
		const base = setup(`mismatch-${mismatch}`);
		let projectRevision = 1;
		let projectId = "project";
		let requests = 0;
		const config: AgentRuntimeConfig = { ...base, hooks: { getProjectFacts: () => ({ projectId, projectRevision, digest: "facts", producedBy: "host" }) } };
		const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "mismatch", async *streamChat(): AsyncGenerator<StreamChunk> {
			requests++; yield { type: "content_delta", delta: "partial" }; yield { type: "done" };
		} });
		try {
			const runtime = createAgentRuntime(config);
			const stopped = await stopAt(runtime.run("question"), "text_delta");
			if (mismatch === "revision") projectRevision++;
			if (mismatch === "identity") projectId = "other-project";
			if (mismatch === "digest") await config.sessionStore.append(config.sessionId, { kind: "user_message", id: "tamper", ts: Date.now(), content: "tampered" });
			const before = await config.sessionStore.load(config.sessionId);
			await expect(collect(runtime.resume(stopped.runId))).rejects.toMatchObject({ category: "tool_failure" });
			expect(await config.sessionStore.load(config.sessionId)).toEqual(before);
			expect(requests).toBe(1);
		} finally { dispose(); }
	});

	test("seeded abrupt model cursor resumes without an explicit interruption", async () => {
		const config = setup("abrupt");
		const entries: AgentSessionEntry[] = [
			{ kind: "run_started", id: "start", ts: 0, runId: "crashed" },
			{ kind: "user_message", id: "user", ts: 0, content: "question" },
			{ kind: "run_state", id: "state", ts: 0, runId: "crashed", seq: 9, iteration: 0, phase: "model", activeRoleId: "general", checkpointId: "boundary" },
		];
		for (const entry of entries) await config.sessionStore.append(config.sessionId, entry);
		await config.sessionStore.saveCheckpoint({ checkpointId: "boundary", sessionId: config.sessionId, createdAt: 0, entrySeq: 2,
			contextDigest: computeContextDigest([{ id: "user", createdAt: 0, role: "user", content: "question" }]), runId: "crashed", seq: 8 });
		await config.ledger!.append({ runId: "crashed", seq: 30, ts: 0, event: { kind: "cancellation" } });
		const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "abrupt", async *streamChat(): AsyncGenerator<StreamChunk> { yield { type: "done" }; } });
		try {
			const events = await collect(createAgentRuntime(config).resume("crashed"));
			expect(events.every(e => e.seq > 30)).toBe(true);
			expect(events.at(-1)?.type).toBe("run_completed");
		} finally { dispose(); }
	});
});

test("cancellation during the first tool preserves its successful result before resuming the second", async () => {
	const base = setup("during-tool");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let executions = 0;
	let requests = 0;
	const config: AgentRuntimeConfig = { ...base, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} }, execute: async () => {
		executions++;
		if (executions === 1) { entered.resolve(); await release.promise; }
		return { success: true, message: "edited" };
	} }] };
	const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "during", async *streamChat(): AsyncGenerator<StreamChunk> {
		if (++requests === 1) yield { type: "tool_calls_complete", toolCalls: [call("during-a"), call("during-b")] };
		yield { type: "done" };
	} });
	try {
		const runtime = createAgentRuntime(config);
		const collecting = collect(runtime.run("twice"));
		await entered.promise;
		runtime.abort();
		release.resolve();
		const interrupted = await collecting;
		expect(executions).toBe(1);
		await collect(createAgentRuntime(config).resume(interrupted[0]!.runId));
		expect(executions).toBe(2);
		expect(requests).toBe(2);
	} finally { release.resolve(); dispose(); }
});

test("resuming an exhausted cap completes without requesting another model turn", async () => {
	const base = setup("resume-cap");
	let requests = 0;
	let executions = 0;
	const config: AgentRuntimeConfig = { ...base, maxIterations: 1, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
		execute: async () => { executions++; return { success: true, message: "ok" }; } }] };
	const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "cap", async *streamChat(): AsyncGenerator<StreamChunk> {
		requests++; yield { type: "tool_calls_complete", toolCalls: [call("cap-call")] }; yield { type: "done" };
	} });
	try {
		const runtime = createAgentRuntime(config);
		const stopped = await stopAt(runtime.run("edit"), "tool_result");
		const events = await collect(createAgentRuntime(config).resume(stopped.runId));
		expect(events.at(-1)?.payload).toMatchObject({ kind: "run_completed", reason: "max_iterations", iterations: 1 });
		expect(requests).toBe(1);
		expect(executions).toBe(1);
	} finally { dispose(); }
});

test("role override is reconstructed through the host hook without persisting credentials", async () => {
	const base = setup("role-resume");
	const roleConfig = { ...base.llmConfig, model: "role-model", apiKey: "role-only-secret" };
	const resolved: string[] = [];
	let requests = 0;
	const config: AgentRuntimeConfig = { ...base, hooks: { onRoleSwitch: roleId => { resolved.push(roleId); return roleConfig; } } };
	const dispose = registerLLMBackendFor(c => c === base.llmConfig || c === roleConfig, { type: "role", async *streamChat(c): AsyncGenerator<StreamChunk> {
		if (++requests === 1) yield { type: "tool_calls_complete", toolCalls: [{ id: "role-call", type: "function", function: { name: "switch_expert_role", arguments: '{"role":"editor"}' } }] };
		yield { type: "done" };
	} });
	try {
		const runtime = createAgentRuntime(config);
		const stopped = await stopAt(runtime.run("switch"), "role_switch");
		await collect(createAgentRuntime(config).resume(stopped.runId));
		expect(resolved).toEqual(["editor", "editor"]);
		const persisted = JSON.stringify(await config.sessionStore.load(config.sessionId)) + JSON.stringify(await config.ledger!.query(stopped.runId));
		expect(persisted).not.toContain(base.llmConfig.apiKey);
		expect(persisted).not.toContain(roleConfig.apiKey);
	} finally { dispose(); }
});

test("a session result append failure after ledger commit rejects and never records completion", async () => {
	class FailResultStore extends InMemorySessionStore {
		override async append(sessionId: string, entry: AgentSessionEntry) {
			if (entry.kind === "tool_result") throw new Error("result append failed");
			await super.append(sessionId, entry);
		}
	}
	const base = setup("result-failure");
	const config: AgentRuntimeConfig = { ...base, sessionStore: new FailResultStore(), tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
		execute: async () => ({ success: true, message: "edited" }) }] };
	const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "failure", async *streamChat(): AsyncGenerator<StreamChunk> {
		yield { type: "tool_calls_complete", toolCalls: [call("failure-call")] }; yield { type: "done" };
	} });
	try {
		await expect(collect(createAgentRuntime(config).run("edit"))).rejects.toThrow("result append failed");
		expect((await config.sessionStore.load(config.sessionId))?.entries.some(entry => entry.kind === "run_completed")).toBe(false);
	} finally { dispose(); }
});

test("failure to save a terminal cursor never appends run_completed", async () => {
	class FailSettledCursorStore extends InMemorySessionStore {
		override async append(sessionId: string, entry: AgentSessionEntry) {
			if (entry.kind === "run_state" && entry.phase === "settled") throw new Error("terminal cursor failed");
			await super.append(sessionId, entry);
		}
	}
	const base = setup("terminal-cursor-failure");
	const config: AgentRuntimeConfig = { ...base, sessionStore: new FailSettledCursorStore(), maxIterations: 0 };
	await expect(collect(createAgentRuntime(config).run("question"))).rejects.toThrow("terminal cursor failed");
	expect((await config.sessionStore.load(config.sessionId))?.entries.some(entry => entry.kind === "run_completed")).toBe(false);
});

test("an invalid cursor checkpoint reference rejects without appending", async () => {
	const config = setup("bad-checkpoint");
	const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "checkpoint", async *streamChat(): AsyncGenerator<StreamChunk> {
		yield { type: "content_delta", delta: "partial" }; yield { type: "done" };
	} });
	try {
		const stopped = await stopAt(createAgentRuntime(config).run("question"), "text_delta");
		await config.sessionStore.append(config.sessionId, { kind: "run_state", id: "bad-cursor", ts: Date.now(), runId: stopped.runId,
			seq: 1000, iteration: 0, phase: "model", activeRoleId: "general", checkpointId: "missing-boundary" });
		const before = await config.sessionStore.load(config.sessionId);
		await expect(collect(createAgentRuntime(config).resume(stopped.runId))).rejects.toMatchObject({ category: "tool_failure" });
		expect(await config.sessionStore.load(config.sessionId)).toEqual(before);
	} finally { dispose(); }
});

test("resumed model iteration receives failures reconstructed from the confirmed tool batch", async () => {
	const base = setup("failure-context-resume");
	let requests = 0;
	const failures: string[] = [];
	const config: AgentRuntimeConfig = { ...base, hooks: { buildErrorRecovery: received => {
		failures.push(...received.map(failure => failure.toolName)); return "repair the failed edit";
	} }, tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
		execute: async () => ({ success: false, message: "failed edit" }) }] };
	const dispose = registerLLMBackendFor(c => c === config.llmConfig, { type: "failures", async *streamChat(_config, messages): AsyncGenerator<StreamChunk> {
		if (++requests === 1) yield { type: "tool_calls_complete", toolCalls: [call("failed-context-call")] };
		else expect(JSON.stringify(messages)).toContain("repair the failed edit");
		yield { type: "done" };
	} });
	try {
		const stopped = await stopAt(createAgentRuntime(config).run("edit"), "tool_result");
		await collect(createAgentRuntime(config).resume(stopped.runId));
		expect(failures).toEqual(["edit"]);
		expect(requests).toBe(2);
	} finally { dispose(); }
});
