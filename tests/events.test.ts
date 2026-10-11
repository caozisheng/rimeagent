import { describe, expect, test } from "bun:test";
import { createAgentRuntimeEvent, parseAgentRuntimeEvent } from "../src/events";
import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "../src/events";

const payloads: AgentRuntimeEventPayload[] = [
	{ kind: "run_started", sessionId: "session" }, { kind: "run_resumed", sessionId: "session" },
	{ kind: "run_interrupted", cause: "interrupted" }, { kind: "run_awaiting_approval", toolCallId: "call" },
	{ kind: "run_completed" }, { kind: "run_failed", error: { category: "provider", message: "offline", retryable: true } },
	{ kind: "iteration_start", iteration: 1 }, { kind: "iteration_end", iteration: 1 },
	{ type: "text_delta", content: "partial" }, { type: "tool_calls_complete", toolCalls: [{ id: "call", type: "function", function: { name: "seek", arguments: '{"time":1}' } }] },
	{ type: "message_end", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5, cost: 0.001 } },
	{ type: "error", message: "offline" }, { type: "status", status: "thinking" },
	{ kind: "tool_result", toolCall: { id: "call", type: "function", function: { name: "seek", arguments: '{}' } }, result: { success: true, message: "ok" } },
	{ kind: "compaction_completed", droppedEntries: 3, summaryDigest: "digest" },
	{ kind: "role_switch", roleId: "editor" },
];

// Typecheck proves consumers can narrow on outer type without checking payload again.
function observable(event: AgentRuntimeEvent): string {
	switch (event.type) {
		case "run_started": return event.payload.sessionId;
		case "text_delta": return event.payload.content;
		case "tool_result": return event.payload.result.message;
		default: return event.runId;
	}
}

describe("versioned runtime events", () => {
	test.each(payloads)("known event payload survives serialized transport: %j", payload => {
		const event = createAgentRuntimeEvent("run", 1, 0, payload);
		const parsed = parseAgentRuntimeEvent(JSON.parse(JSON.stringify(event)));
		expect(parsed).toEqual(event);
	});

	test("unknown future events are safely ignored instead of entering known-event handlers", () => {
		const event = { v: 2, runId: "run", seq: 99, ts: 0, type: "future_notice", payload: { vendor: "extension" } };
		expect(parseAgentRuntimeEvent(event)).toBeNull();
	});

	test("payload and outer type cannot disagree", () => {
		const event = createAgentRuntimeEvent("run", 1, 0, { kind: "run_started", sessionId: "session" });
		expect(() => parseAgentRuntimeEvent({ ...event, type: "run_completed" })).toThrow();
		expect(observable(event)).toBe("session");
	});

	test.each([
		{ v: 3 }, { runId: "" }, { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 },
		{ ts: NaN }, { ts: -1 }, { type: "" }, { apiKey: "secret" },
	])("invalid envelope is rejected before dispatch: %j", patch => {
		const event = createAgentRuntimeEvent("run", 1, 0, { kind: "run_completed" });
		expect(() => parseAgentRuntimeEvent({ ...event, ...patch })).toThrow();
	});

	test.each([
		{ kind: "run_interrupted", cause: "invalid" },
		{ kind: "run_completed", apiKey: "secret" },
		{ kind: "iteration_start", iteration: -1 },
		{ type: "message_end", usage: { totalTokens: NaN } },
		{ type: "tool_calls_complete", toolCalls: [{ id: "x", type: "function", function: { name: "seek" } }] },
		{ type: "status", status: "invalid" },
	])("known payload damage fails explicitly: %j", payload => {
		const type = "kind" in payload ? payload.kind : payload.type;
		expect(() => parseAgentRuntimeEvent({ v: 2, runId: "run", seq: 1, ts: 0, type, payload })).toThrow();
	});

	test("persisted provider causes cannot carry credentials through known event parsing", () => {
		const event = { v: 2, runId: "run", seq: 1, ts: 0, type: "run_failed", payload: {
			kind: "run_failed", error: { category: "provider", message: "offline", retryable: true, cause: { apiKey: "secret" } },
		} };
		expect(() => parseAgentRuntimeEvent(event)).toThrow();
	});

	test("payload accessors are rejected without reading them", () => {
		let reads = 0;
		const payload = Object.defineProperty({}, "kind", { enumerable: true, get() { reads++; return "run_completed"; } });
		expect(() => createAgentRuntimeEvent("run", 1, 0, payload as AgentRuntimeEventPayload)).toThrow();
		expect(reads).toBe(0);
	});

	test("indexed tool-call accessors are rejected without invocation", () => {
		let reads = 0;
		const calls = Object.defineProperty([], "0", { enumerable: true, get() {
			reads++;
			return { id: "call", type: "function", function: { name: "seek", arguments: "{}" } };
		} });
		const payload = { type: "tool_calls_complete", toolCalls: calls } as AgentRuntimeEventPayload;
		expect(() => createAgentRuntimeEvent("run", 1, 0, payload)).toThrow();
		expect(reads).toBe(0);
	});

	test("non-enumerable discriminators cannot disappear during failure sanitization", () => {
		const payload = Object.defineProperty({ error: { category: "provider", message: "offline", retryable: true } },
			"kind", { value: "run_failed", enumerable: false });
		expect(() => createAgentRuntimeEvent("run", 1, 0, payload as AgentRuntimeEventPayload)).toThrow();
	});

	test("synthetic payload discriminators cannot bypass persisted credential protection", () => {
		const payload = new Proxy({ error: { category: "provider", message: "offline", retryable: true, cause: { apiKey: "secret" } } }, {
			get(target, key, receiver) { return key === "type" ? "run_failed" : Reflect.get(target, key, receiver); },
		});
		expect(() => parseAgentRuntimeEvent({ v: 2, runId: "run", seq: 1, ts: 0, type: "run_failed", payload })).toThrow();
	});

	test("proxy iteration methods cannot certify malformed tool calls", () => {
		let invocations = 0;
		const calls = new Proxy([{}], { get(target, key, receiver) {
			return key === "every" ? () => { invocations++; return true; } : Reflect.get(target, key, receiver);
		} });
		expect(() => createAgentRuntimeEvent("run", 1, 0,
			{ type: "tool_calls_complete", toolCalls: calls } as AgentRuntimeEventPayload)).toThrow();
		expect(invocations).toBe(0);
	});

	test("validated sequence must match the serialized own data value", () => {
		const event = new Proxy({ v: 2, runId: "run", seq: 0, ts: 0, type: "run_completed", payload: { kind: "run_completed" } }, {
			get(target, key, receiver) { return key === "seq" ? 1 : Reflect.get(target, key, receiver); },
		});
		expect(() => parseAgentRuntimeEvent(event)).toThrow();
	});

	test.each([
		{ kind: "run_completed", apiKey: undefined },
		{ kind: "run_failed", error: { category: "provider", message: "offline", retryable: true, cause: undefined } },
	])("normalization must not erase prohibited raw event fields: %j", payload => {
		expect(() => parseAgentRuntimeEvent({ v: 2, runId: "run", seq: 1, ts: 0, type: payload.kind, payload })).toThrow();
	});

	test("live error cause is excluded from transport and returned payload is isolated", () => {
		const failure = { category: "provider" as const, message: "offline", retryable: true,
			cause: { apiKey: "secret", request: new Error("opaque") } };
		const event = createAgentRuntimeEvent("run", 1, 0, { kind: "run_failed", error: failure });
		expect(JSON.stringify(event)).not.toContain("secret");
		expect(event.payload.error).toEqual({ category: "provider", message: "offline", retryable: true });
		failure.message = "changed";
		expect(event.payload.error.message).toBe("offline");
	});

});
