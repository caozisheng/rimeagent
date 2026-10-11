import { describe, expect, test } from "bun:test";
import type { AgentMessage, ToolCall } from "../../src/types";
import { computeContextDigest } from "../../src/store/checkpoint";

const call = (id: string): ToolCall => ({
	id, type: "function", function: { name: "lookup", arguments: '{"query":"x"}' },
});
const message = (changes: Partial<AgentMessage> = {}): AgentMessage => ({
	id: "ui-1", role: "user", content: "hello", createdAt: 1, ...changes,
});

describe("computeContextDigest", () => {
	test("uses the frozen UTF-8 FNV-1a32 vector", () => {
		// Canonical bytes: [{"content":"你好🙂","role":"user"}].
		expect(computeContextDigest([message({ content: "你好🙂" })])).toBe("28e3d699");
	});

	test("sorts nested object keys without changing array order", () => {
		const original = message({ role: "assistant", toolCalls: [call("a"), call("b")] });
		const reordered = {
			createdAt: 1, content: "hello", role: "assistant", id: "ui-1",
			toolCalls: [
				{ function: { arguments: '{"query":"x"}', name: "lookup" }, type: "function", id: "a" },
				{ function: { arguments: '{"query":"x"}', name: "lookup" }, type: "function", id: "b" },
			],
		} as AgentMessage;
		expect(computeContextDigest([reordered])).toBe(computeContextDigest([original]));
		expect(computeContextDigest([message({ ...original, toolCalls: [call("b"), call("a")] })]))
			.not.toBe(computeContextDigest([original]));
		expect(computeContextDigest([message(), message({ content: "second" })]))
			.not.toBe(computeContextDigest([message({ content: "second" }), message()]));
	});

	test("ignores UI-only fields and omitted optional model fields", () => {
		const plain = message();
		const ui = message({
			id: "other-ui", createdAt: 999, commandCheckpoint: 17,
			toolResults: [{ name: "lookup", success: true, undoable: true, message: "UI text" }],
			toolCalls: undefined, toolCallId: undefined,
		});
		expect(computeContextDigest([ui])).toBe(computeContextDigest([plain]));
		const opaqueUi = { ...plain, toolResults: new Uint8Array([1, 2]) } as unknown as AgentMessage;
		expect(computeContextDigest([opaqueUi])).toBe(computeContextDigest([plain]));
	});

	test.each([
		{ content: "changed" }, { role: "assistant" }, { toolCallId: "call-1" },
		{ toolCalls: [] }, { toolCalls: [call("a")] },
	] satisfies Partial<AgentMessage>[]) ("includes model-visible field changes: %j", changes => {
		expect(computeContextDigest([message(changes)])).not.toBe(computeContextDigest([message()]));
	});

	test("includes nested tool call arguments", () => {
		const changed = call("a");
		changed.function.arguments = '{"query":"different"}';
		expect(computeContextDigest([message({ toolCalls: [changed] })]))
			.not.toBe(computeContextDigest([message({ toolCalls: [call("a")] })]));
	});

	test.each([
		null, {}, { role: "unknown", content: "x" }, { role: "user", content: 1 },
		{ role: "user", content: "x", toolCallId: "" },
		{ role: "user", content: "x", toolCalls: [null] },
		{ role: "user", content: "x", toolCalls: [{ ...call("a"), extra: "secret" }] },
		{ role: "user", content: "x", toolCalls: new Array(1) },
	])("rejects invalid model-visible input: %j", input => {
		expect(() => computeContextDigest([input] as unknown as AgentMessage[])).toThrow();
	});

	test("inherited array methods cannot bypass model tool-call validation", () => {
		let invocations = 0;
		const calls = Object.setPrototypeOf([null], Object.assign(Object.create(Array.prototype), {
			every() { invocations++; return true; },
		}));
		expect(() => computeContextDigest([message({ toolCalls: calls as ToolCall[] })])).toThrow();
		expect(invocations).toBe(0);
	});

	test("proxy iteration cannot certify invalid model tool-call data", () => {
		const calls = new Proxy([null], { get(target, key, receiver) {
			return key === "every" ? () => true : Reflect.get(target, key, receiver);
		} });
		expect(() => computeContextDigest([message({ toolCalls: calls as unknown as ToolCall[] })])).toThrow();
	});

	test("outer array synthetic length cannot omit conversation facts", () => {
		const messages = new Proxy([message({ content: "required project fact" })], {
			get(target, key, receiver) { return key === "length" ? 0 : Reflect.get(target, key, receiver); },
		});
		expect(computeContextDigest(messages)).toBe(computeContextDigest([message({ content: "required project fact" })]));
	});

	test("rejects inherited required fields and accessors without invoking them", () => {
		let reads = 0;
		const accessor = Object.defineProperty({ role: "user" }, "content", {
			enumerable: true, get() { reads++; return "secret"; },
		});
		expect(() => computeContextDigest([accessor] as AgentMessage[])).toThrow();
		expect(reads).toBe(0);
		expect(() => computeContextDigest([Object.create({ role: "user", content: "x" })])).toThrow();
		expect(() => computeContextDigest(new Array(1))).toThrow();
		expect(() => computeContextDigest(null as unknown as AgentMessage[])).toThrow();
	});
});
