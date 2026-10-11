import type { LLMBackend } from "../src/llm-backend";
import type { AgentSessionConfig, AgentSessionEvent, AgentSessionParams, ToolFailureRecord } from "../src/session";
import type { AgentLLMConfig, AgentMessage, OpenAIMessage, StreamChunk, ToolCall, ToolDefinition } from "../src/types";
import type { AgentToolResult } from "../src/tool-types";
import { describe, expect, test } from "bun:test";
import { registerLLMBackendFor } from "../src/llm-client";
import { ExpertRoleRegistry } from "../src/expert-roles";
import { runAgentSession } from "../src/session";
import { SWITCH_ROLE_TOOL_NAME } from "../src/service";

const user: AgentMessage = { id: "compat-user", role: "user", content: "help", createdAt: 1 };
const ok: AgentToolResult = { success: true, message: "done" };
const text: StreamChunk[] = [{ type: "content_delta", delta: "All " }, { type: "content_delta", delta: "done" }, { type: "done" }];

function call(id: string, name = id, args = "{}"): ToolCall {
	return { id, type: "function", function: { name, arguments: args } };
}
function batch(calls: ToolCall[], content = ""): StreamChunk[] {
	return [...(content ? [{ type: "content_delta" as const, delta: content }] : []), { type: "tool_calls_complete", toolCalls: calls }, { type: "done" }];
}
function fixture(name: string, rounds: StreamChunk[][]) {
	const llmConfig: AgentLLMConfig = { baseUrl: `https://${name}.session-compat.invalid`, apiKey: "", model: "first-model" };
	const requests: { config: AgentLLMConfig; messages: OpenAIMessage[]; tools?: ToolDefinition[] }[] = [];
	const backend: LLMBackend = {
		type: "session-compat",
		async *streamChat(config, messages, _signal, tools) {
			const round = requests.length;
			requests.push(structuredClone({ config, messages, tools }));
			const chunks = rounds[round];
			if (!chunks) throw new Error(`Unexpected request ${round}`);
			yield* chunks;
		},
	};
	const dispose = registerLLMBackendFor(candidate => candidate.baseUrl === llmConfig.baseUrl, backend);
	const params: AgentSessionParams = { messages: [user], llmConfig, expertRoleId: "compat-expert" };
	return { params, requests, dispose };
}
async function collect(params: AgentSessionParams, config: AgentSessionConfig): Promise<AgentSessionEvent[]> {
	const events: AgentSessionEvent[] = [];
	for await (const event of runAgentSession(params, config)) events.push(event);
	return events;
}
const firstTurn: AgentSessionEvent[] = [{ type: "iteration_start", iteration: 0 }, { type: "status", status: "thinking" }];
const textTurn: AgentSessionEvent[] = [{ type: "text_delta", content: "All " }, { type: "text_delta", content: "done" }, { type: "message_end", usage: undefined }];

describe("session compatibility", () => {
	test("text final preserves trace and sends existing user exactly once", async () => {
		const f = fixture("text-final", [text]);
		try {
			expect(await collect(f.params, { maxIterations: 3, onToolCall: async () => { throw new Error("no tools expected"); } })).toEqual([...firstTurn, ...textTurn]);
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0]!.messages.slice(1)).toEqual([{ role: "user", content: "help" }]);
		} finally { f.dispose(); }
	});

	test("JSON-serializable legacy data retains its original value and serialized model history", async () => {
		const tc = call("date-result");
		const f = fixture("date-result", [batch([tc]), text]);
		const result: AgentToolResult = { success: true, message: "dated", data: { completedAt: new Date("2026-10-11T00:00:00Z") } };
		try {
			const events = await collect(f.params, { maxIterations: 2, onToolCall: async () => result });
			const delivered = events.find(event => event.type === "tool_result");
			expect(delivered?.type === "tool_result" && delivered.result).toBe(result);
			expect(f.requests[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
		} finally { f.dispose(); }
	});

	test("an aborted in-flight legacy callback still propagates its rejection", async () => {
		const f = fixture("abort-reject", [batch([call("abort-reject")])]);
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<AgentToolResult>();
		const failure = new DOMException("Tool aborted", "AbortError");
		try {
			const collecting = collect({ ...f.params, signal: controller.signal }, { maxIterations: 2,
				onToolCall: () => { started.resolve(); return pending.promise; } });
			await started.promise;
			controller.abort();
			pending.reject(failure);
			await expect(collecting).rejects.toBe(failure);
			expect(f.requests).toHaveLength(1);
		} finally { pending.resolve(ok); f.dispose(); }
	});

	test("additional legacy result metadata remains available to host and followup model", async () => {
		const tc = call("extended-result");
		const f = fixture("extended-result", [batch([tc]), text]);
		const result = { success: true, message: "done", durationMs: 5 };
		try {
			const events = await collect(f.params, { maxIterations: 2, onToolCall: async () => result });
			const delivered = events.find(event => event.type === "tool_result");
			expect(delivered?.type === "tool_result" && delivered.result).toBe(result);
			expect(f.requests[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
			expect(events.at(-1)?.type).toBe("message_end");
		} finally { f.dispose(); }
	});

	test("two tools execute serially and next request has exact assistant and result history", async () => {
		const calls = [call("one"), call("two")];
		const f = fixture("serial-tools", [batch(calls, "working"), text]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<AgentToolResult>();
		const execution: string[] = [];
		const second: AgentToolResult = { success: true, message: "second", data: { value: 2 } };
		const definition: ToolDefinition = { type: "function", function: { name: "one", description: "first tool", parameters: { type: "object", properties: {} } } };
		try {
			const collecting = collect({ ...f.params, tools: [definition] }, {
				maxIterations: 3,
				onToolCall: async tc => {
					execution.push(tc.id);
					if (tc.id === "one") { started.resolve(); return await release.promise; }
					return second;
				},
			});
			await started.promise;
			expect(execution).toEqual(["one"]);
			expect(f.requests).toHaveLength(1);
			release.resolve(ok);
			expect(await collecting).toEqual([
				...firstTurn, { type: "text_delta", content: "working" }, { type: "tool_calls_complete", toolCalls: calls }, { type: "message_end", usage: undefined },
				{ type: "tool_result", toolCall: calls[0], result: ok }, { type: "tool_result", toolCall: calls[1], result: second },
				{ type: "iteration_start", iteration: 1 }, { type: "status", status: "thinking" }, ...textTurn,
			]);
			expect(execution).toEqual(["one", "two"]);
			expect(f.requests[0]!.tools).toEqual([definition]);
			expect(f.requests[1]!.messages.slice(1)).toEqual([
				{ role: "user", content: "help" }, { role: "assistant", content: "working", tool_calls: calls },
				{ role: "tool", content: JSON.stringify(ok), tool_call_id: "one" },
				{ role: "tool", content: JSON.stringify(second), tool_call_id: "two" },
			]);
		} finally { release.resolve(ok); f.dispose(); }
	});

	test("partial failures preserve order and recovery joins static RAG with two newlines", async () => {
		const calls = [call("broken-one"), call("working"), call("broken-two")];
		const f = fixture("partial-failures", [batch(calls), batch([call("clean")]), text]);
		const results: Record<string, AgentToolResult> = {
			"broken-one": { success: false, message: "missing" }, working: ok,
			"broken-two": { success: false, message: "invalid" }, clean: ok,
		};
		const failures: ToolFailureRecord[][] = [];
		try {
			const events = await collect({ ...f.params, ragContext: "STATIC-RAG" }, {
				maxIterations: 4, onToolCall: async tc => results[tc.id]!,
				onIterationFailures: records => { failures.push(records); return "RECOVER-CONTEXT"; },
			});
			expect(failures).toEqual([[{ toolName: "broken-one", errorMessage: "missing" }, { toolName: "broken-two", errorMessage: "invalid" }]]);
			expect(f.requests[1]!.messages[0]!.content).toContain("STATIC-RAG\n\nRECOVER-CONTEXT");
			expect(f.requests[2]!.messages[0]!.content).not.toContain("RECOVER-CONTEXT");
			expect(events.filter(event => event.type === "tool_result").map(event => event.toolCall.id)).toEqual(["broken-one", "working", "broken-two", "clean"]);
		} finally { f.dispose(); }
	});

	test("orchestrator role switch changes next model and prompt without ordinary tool callback", async () => {
		const orchestrator = "compat-orchestrator";
		const specialist = "compat-specialist";
		ExpertRoleRegistry.register({ id: orchestrator, name: "Compat orchestrator", description: "coordinate", systemPromptAddition: "ORCHESTRATOR-PROMPT", isOrchestrator: true });
		ExpertRoleRegistry.register({ id: specialist, name: "Compat specialist", description: "specialize", systemPromptAddition: "SPECIALIST-PROMPT" });
		const tc = call("switch", SWITCH_ROLE_TOOL_NAME, JSON.stringify({ role: specialist }));
		const f = fixture("role-switch", [batch([tc]), text]);
		const roles: string[] = [];
		try {
			const events = await collect({ ...f.params, expertRoleId: orchestrator }, {
				maxIterations: 3, onToolCall: async () => { throw new Error("role switch is not an ordinary tool"); },
				onRoleSwitch: role => { roles.push(role); return { ...f.params.llmConfig, model: "specialist-model" }; },
			});
			expect(events).toEqual([...firstTurn, { type: "tool_calls_complete", toolCalls: [tc] }, { type: "message_end", usage: undefined }, { type: "role_switch", roleId: specialist }, { type: "iteration_start", iteration: 1 }, { type: "status", status: "thinking" }, ...textTurn]);
			expect(roles).toEqual([specialist]);
			expect(f.requests[1]!.config.model).toBe("specialist-model");
			expect(f.requests[1]!.messages[0]!.content).toContain("SPECIALIST-PROMPT");
			expect(f.requests[1]!.messages.slice(1)).toEqual([
				{ role: "user", content: "help" }, { role: "assistant", content: null, tool_calls: [tc] },
				{ role: "tool", content: JSON.stringify({ success: true, message: `Switched to ${specialist}` }), tool_call_id: "switch" },
			]);
		} finally { f.dispose(); }
	});

	test("malformed and missing role arguments retain the active role", async () => {
		const calls = [call("bad-json", SWITCH_ROLE_TOOL_NAME, "{"), call("no-role", SWITCH_ROLE_TOOL_NAME)];
		const f = fixture("role-fallback", [batch(calls), text]);
		const roles: string[] = [];
		try {
			await collect({ ...f.params, activeRoleId: "existing-role" }, { maxIterations: 2, onToolCall: async () => ok, onRoleSwitch: role => { roles.push(role); } });
			expect(roles).toEqual(["existing-role", "existing-role"]);
		} finally { f.dispose(); }
	});

	for (const callback of ["tool", "role", "failures"] as const) {
		test(`${callback} callback exceptions still reject the consumer`, async () => {
			const tc = call("throws", callback === "role" ? SWITCH_ROLE_TOOL_NAME : "throws");
			const f = fixture(`throws-${callback}`, [batch([tc]), text]);
			const failure = new Error(`${callback} callback rejected`);
			try {
				await expect(collect(f.params, {
					maxIterations: 3,
					onToolCall: async () => { if (callback === "tool") throw failure; return { success: false, message: "failed" }; },
					onRoleSwitch: () => { throw failure; }, onIterationFailures: () => { throw failure; },
				})).rejects.toBe(failure);
				expect(f.requests).toHaveLength(1);
			} finally { f.dispose(); }
		});
	}

	test("max iterations exposes only the old trace, without lifecycle events", async () => {
		const tc = call("last-tool");
		const f = fixture("iteration-cap", [batch([tc])]);
		try {
			expect(await collect(f.params, { maxIterations: 1, onToolCall: async () => ok })).toEqual([...firstTurn, { type: "tool_calls_complete", toolCalls: [tc] }, { type: "message_end", usage: undefined }, { type: "tool_result", toolCall: tc, result: ok }]);
			expect(f.requests).toHaveLength(1);
		} finally { f.dispose(); }
	});

	test("preaborted signal produces neither legacy events nor model requests", async () => {
		const f = fixture("preabort", []);
		const controller = new AbortController();
		controller.abort();
		try {
			expect(await collect({ ...f.params, signal: controller.signal }, { maxIterations: 3, onToolCall: async () => { throw new Error("must not run"); } })).toEqual([]);
			expect(f.requests).toEqual([]);
		} finally { f.dispose(); }
	});
});

