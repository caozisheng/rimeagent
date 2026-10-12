import { expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import { InMemorySessionStore } from "../../src/store/session-store";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentLLMConfig, StreamChunk } from "../../src/types";
import type { AgentSessionEntry } from "../../src/store/entries";

test("runtime executes and persists a user/assistant turn with observable completion", async () => {
	const llmConfig: AgentLLMConfig = { baseUrl: "https://phase3.test", apiKey: "key", model: "model" };
	const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "phase3", async *streamChat(): AsyncGenerator<StreamChunk> {
		yield { type: "content_delta", delta: "edited" };
		yield { type: "done" };
	} });
	try {
		const sessionStore = new InMemorySessionStore();
		const runtime = createAgentRuntime({ sessionId: "s", sessionStore, llmConfig, expertRoleId: "general", tools: [] });
		const events = [];
		for await (const event of runtime.run("edit")) events.push(event);
		expect(events.find(e => e.type === "run_completed")?.payload).toEqual({ kind: "run_completed", reason: "response", iterations: 1 });
		expect((await sessionStore.load("s"))?.entries.filter(e => e.kind === "user_message" || e.kind === "assistant_message").map(e => e.content)).toEqual(["edit", "edited"]);
		expect(runtime.state).toBe("settled");
	} finally { dispose(); }
});

test("closing at message_end preserves the already-confirmed assistant response", async () => {
	const llmConfig: AgentLLMConfig = { baseUrl: "https://confirmed.test", apiKey: "key", model: "model" };
	const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "confirmed", async *streamChat(): AsyncGenerator<StreamChunk> {
		yield { type: "content_delta", delta: "confirmed answer" };
		yield { type: "done" };
	} });
	try {
		const sessionStore = new InMemorySessionStore();
		const runtime = createAgentRuntime({ sessionId: "confirmed", sessionStore, llmConfig, expertRoleId: "general", tools: [] });
		const stream = runtime.run("question");
		while (true) {
			const step = await stream.next();
			if (step.done || step.value.type === "message_end") break;
		}
		await stream.return(undefined);
		expect((await sessionStore.load("confirmed"))?.entries.filter(e => e.kind === "assistant_message").map(e => e.content)).toEqual(["confirmed answer"]);
		expect(runtime.state).toBe("interrupted");
	} finally { dispose(); }
});

test("a fresh run does not send unresolved tool-call history to the provider", async () => {
	const llmConfig: AgentLLMConfig = { baseUrl: "https://unfinished.test", apiKey: "key", model: "model" };
	let requests = 0;
	let executions = 0;
	const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "unfinished", async *streamChat(): AsyncGenerator<StreamChunk> {
		requests++;
		if (requests === 1) yield { type: "tool_calls_complete", toolCalls: [{ id: "pending", type: "function", function: { name: "edit", arguments: "{}" } }] };
		yield { type: "done" };
	} });
	try {
		const sessionStore = new InMemorySessionStore();
		const runtime = createAgentRuntime({ sessionId: "unfinished", sessionStore, llmConfig, expertRoleId: "general",
			tools: [{ name: "edit", description: "edit", parameters: { type: "object", properties: {} },
				execute: async () => { executions++; return { success: true, message: "edited" }; } }] });
		const stream = runtime.run("edit");
		while (true) {
			const step = await stream.next();
			if (step.done || step.value.type === "message_end") break;
		}
		await stream.return(undefined);
		await expect(runtime.run("new question").next()).rejects.toMatchObject({ category: "tool_failure", retryable: false });
		expect(requests).toBe(1);
		expect(executions).toBe(0);
		expect((await sessionStore.load("unfinished"))?.entries.filter(entry => entry.kind === "user_message").map(entry => entry.content)).toEqual(["edit"]);
	} finally { dispose(); }
});

test("new runtime does not execute approval-sensitive tools before a gate exists", async () => {
	const llmConfig: AgentLLMConfig = { baseUrl: "https://approval.test", apiKey: "key", model: "model" };
	let executions = 0;
	const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "approval", async *streamChat(): AsyncGenerator<StreamChunk> {
		yield { type: "tool_calls_complete", toolCalls: [{ id: "delete", type: "function", function: { name: "delete", arguments: "{}" } }] };
		yield { type: "done" };
	} });
	try {
		const runtime = createAgentRuntime({ sessionId: "approval", sessionStore: new InMemorySessionStore(), llmConfig, expertRoleId: "general", maxIterations: 1,
			tools: [{ name: "delete", description: "delete", parameters: { type: "object", properties: {} }, annotations: { destructive: true },
				execute: async () => { executions++; return { success: true, message: "deleted" }; } }] });
		const events = [];
		for await (const event of runtime.run("delete")) events.push(event);
		expect(executions).toBe(0);
		const result = events.find(event => event.type === "tool_result");
		expect(result?.payload.result.success).toBe(false);
	} finally { dispose(); }
});

test("a failed durable append is not mislabeled as cancellation", async () => {
	class FailOnceStore extends InMemorySessionStore {
		calls = 0;
		override async append(sessionId: string, entry: AgentSessionEntry) {
			if (++this.calls === 2) throw new Error("durable append failed");
			await super.append(sessionId, entry);
		}
	}
	const sessionStore = new FailOnceStore();
	const runtime = createAgentRuntime({ sessionId: "write-failure", sessionStore,
		llmConfig: { baseUrl: "https://unused.test", apiKey: "", model: "model" }, expertRoleId: "general", tools: [] });
	const collecting = (async () => { for await (const _ of runtime.run("question")) { /* drain */ } })();
	await expect(collecting).rejects.toThrow("durable append failed");
	const entries = (await sessionStore.load("write-failure"))?.entries ?? [];
	expect(entries.some(entry => entry.kind === "run_interrupted")).toBe(false);
	expect(entries.at(-1)?.kind).toBe("run_failed");
	expect(runtime.state).toBe("settled");
});

test("provider cleanup rejection cannot bypass the early-close interruption boundary", async () => {
	const llmConfig: AgentLLMConfig = { baseUrl: "https://cleanup.test", apiKey: "key", model: "model" };
	const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "cleanup", async *streamChat(): AsyncGenerator<StreamChunk> {
		try { yield { type: "content_delta", delta: "partial" }; }
		finally { throw new Error("provider cleanup failed"); }
	} });
	try {
		const sessionStore = new InMemorySessionStore();
		const runtime = createAgentRuntime({ sessionId: "cleanup", sessionStore, llmConfig, expertRoleId: "general", tools: [] });
		const stream = runtime.run("question");
		while (true) {
			const step = await stream.next();
			if (step.done || step.value.type === "text_delta") break;
		}
		await expect(stream.return(undefined)).rejects.toThrow("provider cleanup failed");
		expect((await sessionStore.load("cleanup"))?.entries.some(entry => entry.kind === "run_interrupted")).toBe(true);
		expect((await sessionStore.listCheckpoints("cleanup")).length).toBeGreaterThan(0);
		expect(runtime.state).toBe("interrupted");
	} finally { dispose(); }
});
