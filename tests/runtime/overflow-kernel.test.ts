import { describe, expect, test } from "bun:test";
import type { AgentLLMConfig, AgentMessage, StreamChunk, ToolCall } from "../../src/types";
import type { AgentRuntimeEventPayload } from "../../src/events";
import type { NormalizedError } from "../../src/errors";
import type { IterationHooks, IterationOutcome, IterationStream } from "../../src/runtime/iteration";
import { runSessionIterations } from "../../src/runtime/iteration";
import { registerLLMBackendFor } from "../../src/llm-client";
import { normalizeError } from "../../src/errors";
import { prepareAgentRequest, runAgentLoop, runPreparedAgentLoop } from "../../src/service";

const user: AgentMessage = { id: "user", role: "user", content: "continue", createdAt: 1 };
const call: ToolCall = { id: "confirmed-call", type: "function", function: { name: "edit", arguments: "{}" } };
const overflow = normalizeError({ code: "context_length_exceeded", message: "Rejected", apiKey: "secret" });
function fixture(name: string, rounds: StreamChunk[][], closed: number[] = []) {
	const llmConfig: AgentLLMConfig = { baseUrl: `https://${name}.kernel.invalid`, apiKey: "secret", model: name };
	let requests = 0;
	const dispose = registerLLMBackendFor(c => c.baseUrl === llmConfig.baseUrl, {
		type: "overflow-test", async *streamChat() {
			const index = requests++;
			try { yield* rounds[index] ?? [{ type: "done" }]; }
			finally { closed.push(index); }
		},
	});
	return { params: { llmConfig, messages: [user], expertRoleId: "general" }, dispose, requests: () => requests };
}
async function drain(stream: IterationStream): Promise<{ events: AgentRuntimeEventPayload[]; outcome: IterationOutcome }> {
	const events: AgentRuntimeEventPayload[] = [];
	while (true) {
		const step = await stream.next();
		if (step.done) return { events, outcome: step.value };
		events.push(step.value);
	}
}
const noTools = { maxIterations: 1, onToolCall: async () => { throw new Error("unconfirmed execution"); } };

describe("prepared request recovery kernel", () => {
	test("code-only overflow uses attempts zero through three and closes before each recovery", async () => {
		const closed: number[] = [];
		const f = fixture("three-stages", Array.from({ length: 4 }, () => [{ type: "error", message: "Rejected", error: overflow }]), closed);
		const attempts: number[] = [], recoveries: number[] = [];
		try {
			const result = await drain(runSessionIterations(f.params, noTools, {
				beforeRequest: input => { attempts.push(input.attempt); expect(input.iteration).toBe(0); return prepareAgentRequest(input.params); },
				onContextOverflow: (error, attempt) => { expect(closed).toHaveLength(attempt + 1); expect(error.category).toBe("context_overflow"); expect(error).not.toHaveProperty("cause"); recoveries.push(attempt); return true; },
			}));
			expect(attempts).toEqual([0, 1, 2, 3]);
			expect(recoveries).toEqual([0, 1, 2]);
			expect(result.outcome).toMatchObject({ reason: "error", iterations: 1, error: { category: "context_overflow" } });
			expect(result.events.filter(e => "type" in e && e.type === "error")).toEqual([{ type: "error", message: "Rejected" }]);
		} finally { f.dispose(); }
	});

	test("partial calls and text are discarded and the confirmed batch executes only once", async () => {
		const stale = { ...call, id: "discard-me" };
		const f = fixture("partial-batch", [
			[{ type: "content_delta", delta: "discarded" }, { type: "tool_calls_complete", toolCalls: [stale] }, { type: "error", message: "Rejected", error: overflow }],
			[{ type: "content_delta", delta: "confirmed" }, { type: "tool_calls_complete", toolCalls: [call] }, { type: "done" }],
			[{ type: "done" }],
		]);
		const history: AgentMessage[] = [], starts: string[] = [], executed: string[] = [];
		try {
			const result = await drain(runSessionIterations(f.params, { maxIterations: 2, onToolCall: async tc => { executed.push(tc.id); return { success: true, message: "done" }; } }, {
				beforeRequest: input => { if (input.attempt === 1) { expect(history).toEqual([]); expect(starts).toEqual([]); } return prepareAgentRequest(input.params); },
				onContextOverflow: () => true,
				onMessage: async message => { history.push(message); }, onToolStart: async tc => { starts.push(tc.id); },
			}));
			expect(result.outcome.reason).toBe("response"); expect(executed).toEqual([call.id]); expect(starts).toEqual([call.id]);
			expect(history[0]).toMatchObject({ content: "confirmed", toolCalls: [call] });
			expect(history.some(m => m.content.includes("discarded"))).toBe(false);
		} finally { f.dispose(); }
	});

	test("provider errors do not retry even when retryable", async () => {
		const f = fixture("no-provider-retry", [[{ type: "error", message: "Busy", error: normalizeError({ status: 503, message: "Busy" }) }]]);
		try {
			const result = await drain(runSessionIterations(f.params, noTools, { beforeRequest: input => prepareAgentRequest(input.params), onContextOverflow: () => { throw new Error("provider recovery"); } }));
			expect(f.requests()).toBe(1); expect(result.outcome.error?.category).toBe("provider");
		} finally { f.dispose(); }
	});

	test("preparation overflow recovers without transport and metadata precedes provider", async () => {
		const f = fixture("preflight-overflow", [[{ type: "done" }]]);
		const attempts: number[] = [];
		try {
			const result = await drain(runSessionIterations(f.params, noTools, {
				beforeRequest: input => { attempts.push(input.attempt); if (!input.attempt) throw overflow; return { ...prepareAgentRequest(input.params), events: [{ kind: "compaction_completed", droppedEntries: 2, summaryDigest: "digest" }] }; },
				onContextOverflow: () => true,
			}));
			expect(attempts).toEqual([0, 1]); expect(f.requests()).toBe(1);
			expect(result.events.slice(1, 3)).toEqual([{ kind: "compaction_completed", droppedEntries: 2, summaryDigest: "digest" }, { type: "status", status: "thinking" }]);
		} finally { f.dispose(); }
	});

	test("storage and recovery hook errors propagate instead of retrying", async () => {
		for (const hook of ["beforeRequest", "onContextOverflow"] as const) {
			const f = fixture(`storage-${hook}`, [[{ type: "error", message: "Rejected", error: overflow }]]);
			const failure = new Error("storage failure");
			const hooks: IterationHooks = { beforeRequest: input => prepareAgentRequest(input.params), onContextOverflow: () => true };
			if (hook === "beforeRequest") hooks.beforeRequest = () => { throw failure; };
			else hooks.onContextOverflow = () => { throw failure; };
			try { await expect(drain(runSessionIterations(f.params, noTools, hooks))).rejects.toBe(failure); }
			finally { f.dispose(); }
		}
	});

	test("closing at retry metadata prevents the next provider request", async () => {
		const closed: number[] = [];
		const f = fixture("close-retry", [[{ type: "error", message: "Rejected", error: overflow }]], closed);
		const stream = runSessionIterations(f.params, noTools, { beforeRequest: input => ({ ...prepareAgentRequest(input.params), events: input.attempt ? [{ kind: "compaction_completed", droppedEntries: 1, summaryDigest: "digest" }] : [] }), onContextOverflow: () => true });
		try {
			while (true) { const step = await stream.next(); if (step.done) throw new Error("missing metadata"); if ("kind" in step.value && step.value.kind === "compaction_completed") break; }
			await stream.return({ reason: "interrupted", iterations: 1 });
			expect(f.requests()).toBe(1); expect(closed).toEqual([0]);
		} finally { f.dispose(); }
	});

	test("abort during recovery neither prepares nor starts the next request", async () => {
		const f = fixture("abort-retry", [[{ type: "error", message: "Rejected", error: overflow }]]);
		const controller = new AbortController(); let preparations = 0;
		try {
			const result = await drain(runSessionIterations({ ...f.params, signal: controller.signal }, noTools, { beforeRequest: input => { preparations++; return prepareAgentRequest(input.params); }, onContextOverflow: () => { controller.abort(); return true; } }));
			expect(result.outcome.reason).toBe("interrupted"); expect(preparations).toBe(1); expect(f.requests()).toBe(1);
		} finally { f.dispose(); }
	});

	test("request hooks see switched model, failures, and legacy recovery context", async () => {
		const switched: ToolCall = { id: "switch", type: "function", function: { name: "switch_expert_role", arguments: '{"role":"editor"}' } };
		const f = fixture("role-config", [[{ type: "tool_calls_complete", toolCalls: [switched, call] }, { type: "done" }], [{ type: "done" }]]);
		const roleConfig = { ...f.params.llmConfig, model: "editor-model" };
		const models: string[] = [], failures: number[] = [];
		try {
			await drain(runSessionIterations(f.params, { maxIterations: 2, onToolCall: async () => ({ success: false, message: "failed" }), onRoleSwitch: () => roleConfig, onIterationFailures: () => "recover" }, {
				beforeIteration: () => ({ ragContext: "fresh" }),
				beforeRequest: input => { models.push(input.params.llmConfig.model); failures.push(input.failures.length); if (input.iteration === 1) expect(input.params.ragContext).toBe("fresh\n\nrecover"); return prepareAgentRequest(input.params); },
			}));
			expect(models).toEqual([f.params.llmConfig.model, roleConfig.model]); expect(failures).toEqual([0, 1]);
		} finally { f.dispose(); }
	});

	test("prepared errors omit causes and legacy wrapper retains exact error shape", async () => {
		const error: NormalizedError = { category: "context_overflow", message: "Rejected", retryable: false, cause: { apiKey: "secret" } };
		const f = fixture("sanitized", [[{ type: "error", message: "Rejected", error }], [{ type: "error", message: "Rejected", error }]]);
		try {
			const prepared = []; for await (const event of runPreparedAgentLoop(prepareAgentRequest(f.params))) prepared.push(event);
			expect(prepared.at(-1)).toEqual({ type: "error", message: "Rejected", error: { category: "context_overflow", message: "Rejected", retryable: false } });
			const legacy = []; for await (const event of runAgentLoop(f.params)) legacy.push(event);
			expect(legacy.at(-1)).toEqual({ type: "error", message: "Rejected" });
		} finally { f.dispose(); }
	});

	test("provider-thrown normalized overflow recovers after closing its stream", async () => {
		const llmConfig = { baseUrl: "https://throw-overflow.kernel.invalid", apiKey: "", model: "throws" };
		let calls = 0, closed = 0;
		const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "throw-overflow", async *streamChat(): AsyncGenerator<StreamChunk> {
			try { if (!calls++) throw overflow; yield { type: "done" }; } finally { closed++; }
		} });
		try {
			const result = await drain(runSessionIterations({ llmConfig, messages: [user], expertRoleId: "general" }, noTools, {
				beforeRequest: input => prepareAgentRequest(input.params), onContextOverflow: () => { expect(closed).toBe(1); return true; },
			}));
			expect(result.outcome.reason).toBe("response"); expect(calls).toBe(2); expect(closed).toBe(2);
		} finally { dispose(); }
	});

	test("overflow-shaped cleanup after confirmation is not retried", async () => {
		const llmConfig = { baseUrl: "https://confirmed-cleanup.kernel.invalid", apiKey: "", model: "confirmed" };
		let requests = 0, confirmations = 0, recoveries = 0;
		const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "confirmed-cleanup", async *streamChat(): AsyncGenerator<StreamChunk> {
			requests++;
			try { yield { type: "done" }; } finally { throw overflow; }
		} });
		try {
			await expect(drain(runSessionIterations({ llmConfig, messages: [user], expertRoleId: "general" }, noTools, {
				beforeRequest: input => prepareAgentRequest(input.params), onMessage: async () => { confirmations++; },
				onContextOverflow: () => { recoveries++; return true; },
			}))).rejects.toBe(overflow);
			expect(requests).toBe(1); expect(confirmations).toBe(1); expect(recoveries).toBe(0);
		} finally { dispose(); }
	});

	test("consumer close with normalized overflow cleanup never invokes recovery", async () => {
		const llmConfig = { baseUrl: "https://close-overflow.kernel.invalid", apiKey: "", model: "close" };
		let requests = 0, recoveries = 0;
		const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "close-overflow", async *streamChat(): AsyncGenerator<StreamChunk> {
			requests++;
			try { yield { type: "content_delta", delta: "partial" }; } finally { throw overflow; }
		} });
		const stream = runSessionIterations({ llmConfig, messages: [user], expertRoleId: "general" }, noTools, {
			beforeRequest: input => prepareAgentRequest(input.params), onContextOverflow: () => { recoveries++; return true; },
		});
		try {
			while (true) { const step = await stream.next(); if (step.done) throw new Error("missing text"); if ("type" in step.value && step.value.type === "text_delta") break; }
			await expect(stream.return({ reason: "interrupted", iterations: 1 })).rejects.toBe(overflow);
			expect(requests).toBe(1); expect(recoveries).toBe(0);
		} finally { dispose(); }
	});

	test("legacy cleanup exceptions still propagate and callbacks stay unchanged", async () => {
		const llmConfig = { baseUrl: "https://legacy-cleanup.kernel.invalid", apiKey: "", model: "legacy" };
		const failure = new Error("cleanup rejected");
		const dispose = registerLLMBackendFor(c => c === llmConfig, { type: "cleanup", async *streamChat(): AsyncGenerator<StreamChunk> { try { yield { type: "content_delta", delta: "partial" }; } finally { throw failure; } } });
		const stream = runSessionIterations({ llmConfig, messages: [user], expertRoleId: "general" }, noTools);
		try { await stream.next(); await stream.next(); await stream.next(); await expect(stream.return({ reason: "interrupted", iterations: 1 })).rejects.toBe(failure); }
		finally { dispose(); }
	});
});
