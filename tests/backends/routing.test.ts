import { describe, expect, test } from "bun:test";
import { RimeAgentBackend } from "../../src/llm-backend";
import type { LLMBackend } from "../../src/llm-backend";
import { getLLMBackend, registerLLMBackend, registerLLMBackendFor, resolveProvider, streamChatCompletion } from "../../src/llm-client";
import type { AgentLLMConfig } from "../../src/types";

function configuration(model: string): AgentLLMConfig {
	return { baseUrl: "https://routing-tests.invalid/v1", apiKey: "", model };
}

function backend(type: string): LLMBackend {
	return { type, async *streamChat() { yield { type: "content_delta", delta: type }; yield { type: "done" }; } };
}

describe("backend routing", () => {
	test("returns the same baseline singleton for both protocols", () => {
		const baseline = getLLMBackend(configuration("baseline-singleton"));
		expect(baseline).toBeInstanceOf(RimeAgentBackend);
		expect(baseline.type).toBe("rimeagent");
		expect(getLLMBackend({ ...configuration("baseline-singleton"), baseUrl: "https://api.anthropic.com" })).toBe(baseline);
	});

	test("retains explicit provider resolution and native host inference", () => {
		const native = { ...configuration("provider-resolution"), baseUrl: "https://api.anthropic.com" };
		expect(resolveProvider(native)).toBe("anthropic");
		expect(resolveProvider({ ...native, provider: "custom" })).toBe("anthropic");
		expect(resolveProvider({ ...native, provider: "openai" })).toBe("openai");
		expect(resolveProvider({ ...configuration("provider-resolution"), provider: "anthropic" })).toBe("anthropic");
		expect(resolveProvider({ ...native, baseUrl: "/relative" })).toBe("openai");
	});

	test("selects the newest matching predicate and reveals older registration after cleanup", () => {
		const config = configuration("predicate-precedence");
		const baseline = getLLMBackend(config);
		const older = backend("older");
		const newer = backend("newer");
		const other = backend("nonmatching");
		const disposeOlder = registerLLMBackendFor((candidate) => candidate.model === config.model, older);
		const disposeNewer = registerLLMBackendFor((candidate) => candidate.model === config.model, newer);
		const disposeOther = registerLLMBackendFor((candidate) => candidate.model === "unrelated-config", other);
		try {
			expect(getLLMBackend(config)).toBe(newer);
			expect(getLLMBackend(configuration("unmatched-config"))).toBe(baseline);
			disposeNewer();
			expect(getLLMBackend(config)).toBe(older);
			disposeNewer();
			expect(getLLMBackend(config)).toBe(older);
			disposeOlder();
			expect(getLLMBackend(config)).toBe(baseline);
		} finally {
			disposeOlder();
			disposeNewer();
			disposeOther();
		}
	});

	test("rejects duplicate predicate identity but permits equivalent functions", () => {
		const config = configuration("duplicate-predicate");
		const predicate = (candidate: AgentLLMConfig) => candidate.model === config.model;
		const first = backend("first");
		const second = backend("second");
		const disposeFirst = registerLLMBackendFor(predicate, first);
		let disposeSecond: (() => void) | undefined;
		try {
			expect(() => registerLLMBackendFor(predicate, second)).toThrow();
			disposeSecond = registerLLMBackendFor((candidate) => candidate.model === config.model, second);
			expect(getLLMBackend(config)).toBe(second);
			disposeSecond();
			expect(getLLMBackend(config)).toBe(first);
		} finally {
			disposeFirst();
			disposeSecond?.();
		}
	});

	test("allows re-registering disposed predicate without stale disposer deleting its replacement", () => {
		const config = configuration("predicate-reregistration");
		const baseline = getLLMBackend(config);
		const predicate = (candidate: AgentLLMConfig) => candidate.model === config.model;
		const disposeFirst = registerLLMBackendFor(predicate, backend("first"));
		disposeFirst();
		const replacement = backend("replacement");
		const disposeReplacement = registerLLMBackendFor(predicate, replacement);
		try {
			disposeFirst();
			expect(getLLMBackend(config)).toBe(replacement);
			disposeReplacement();
			expect(getLLMBackend(config)).toBe(baseline);
		} finally {
			disposeReplacement();
		}
	});

	test("retains legacy last-registration-wins below predicate registrations", () => {
		const config = configuration("legacy-precedence");
		const previous = getLLMBackend(config);
		const first = backend("legacy-first");
		const second = backend("legacy-second");
		const routed = backend("predicate");
		const dispose = registerLLMBackendFor((candidate) => candidate.model === config.model, routed);
		try {
			registerLLMBackend(first);
			expect(getLLMBackend(configuration("legacy-fallback"))).toBe(first);
			expect(getLLMBackend(config)).toBe(routed);
			registerLLMBackend(second);
			expect(getLLMBackend(configuration("legacy-fallback"))).toBe(second);
			expect(getLLMBackend(config)).toBe(routed);
			dispose();
			expect(getLLMBackend(config)).toBe(second);
		} finally {
			dispose();
			registerLLMBackend(previous);
		}
	});

	test("streamChatCompletion uses the config-selected backend", async () => {
		const config = configuration("stream-routing");
		const dispose = registerLLMBackendFor((candidate) => candidate.model === config.model, backend("selected"));
		try {
			const chunks = [];
			for await (const chunk of streamChatCompletion(config, [])) chunks.push(chunk);
			expect(chunks).toEqual([{ type: "content_delta", delta: "selected" }, { type: "done" }]);
		} finally {
			dispose();
		}
	});
});
