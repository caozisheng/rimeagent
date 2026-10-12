import { expect, test } from "bun:test";
import { createContextManager } from "../../src/runtime/context-manager";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemorySessionStore } from "../../src/store/session-store";
import type { AgentSessionEntry } from "../../src/store/entries";
import type { AgentArtifact } from "../../src/store/artifact-store";
import type { ToolDefinition } from "../../src/types";

const llmConfig = { baseUrl: "https://context.invalid", apiKey: "not-persisted", model: "projection", contextLength: 1024 };
const input = { llmConfig, systemPrompt: "system instruction", tools: [] as ToolDefinition[] };
const call = (id: string) => ({ id, type: "function" as const, function: { name: "inspect", arguments: "{}" } });
async function fixture(entries: AgentSessionEntry[]) {
	const sessionStore = new InMemorySessionStore();
	const artifactStore = new InMemoryArtifactStore();
	for (const entry of entries) await sessionStore.append("projection", entry);
	return { sessionId: "projection", sessionStore, artifactStore };
}

 test("counts the complete model prompt including tool schemas, calls and IDs, not history metadata", async () => {
	const options = await fixture([
		{ kind: "user_message", id: "u", ts: 99999999, content: "question" },
		{ kind: "assistant_message", id: "a", ts: 1, content: "", toolCalls: [call("c")] },
		{ kind: "tool_result", id: "r", ts: 2, toolCallId: "c", result: { success: true, message: "ok" } },
	]);
	const manager = createContextManager({ ...options, config: { tokenizer: text => text.length } });
	const tools: ToolDefinition[] = [{ type: "function", function: { name: "inspect", description: "x".repeat(500), parameters: { type: "object", properties: {} } } }];
	const projected = await manager.project({ ...input, tools });
	expect((await manager.project(input)).tokensUsed).toBeLessThan(projected.tokensUsed);
	expect(projected.tokensUsed).toBeGreaterThan(manager.getBudget(llmConfig).inputTokens);
});

 test("small model defaults leave input while explicit invalid budgets and tokenizer outputs reject", async () => {
	const options = await fixture([]);
	const manager = createContextManager(options);
	expect(manager.getBudget(llmConfig)).toMatchObject({ contextTokens: 1024, reserveOutputTokens: 512, inputTokens: 512 });
	for (const config of [{ contextTokens: 0 }, { reserveOutputTokens: -1 }, { compactTriggerRatio: 0 }, { compactTriggerRatio: 1.1 }, { maxToolResultTokens: 0 }]) {
		expect(() => createContextManager({ ...options, config })).toThrow();
	}
	expect(() => createContextManager({ ...options, config: { reserveOutputTokens: 1024 } }).getBudget(llmConfig)).toThrow();
	for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		const bad = createContextManager({ ...options, config: { tokenizer: () => invalid } });
		expect(() => bad.countTokens("text")).toThrow();
	}
});

 test("pending tool groups stay visible and malformed tool protocol rejects", async () => {
	const options = await fixture([
		{ kind: "user_message", id: "u", ts: 0, content: "latest goal" },
		{ kind: "assistant_message", id: "a", ts: 1, content: "", toolCalls: [call("one"), call("two")] },
		{ kind: "tool_result", id: "r", ts: 2, toolCallId: "one", result: { success: true, message: "ok" } },
	]);
	expect((await createContextManager(options).project({ ...input, forceCompact: true })).messages.map(message => message.id)).toEqual(["u", "a", "r"]);
	await options.sessionStore.append("projection", { kind: "user_message", id: "bad", ts: 3, content: "interleaved" });
	await expect(createContextManager(options).project(input)).rejects.toThrow();
	const unmatched = await fixture([{ kind: "tool_result", id: "r", ts: 0, toolCallId: "missing", result: { success: false, message: "error" } }]);
	await expect(createContextManager(unmatched).project(input)).rejects.toThrow();
});

 test("huge failed JSON results are bounded without leaking data and immutable artifacts survive reprojection and reopen", async () => {
	const result = { success: false, message: "operation failed " + "x".repeat(10000), data: { privatePayload: "SECRET_RAW".repeat(20000) }, undoable: false };
	const options = await fixture([
		{ kind: "assistant_message", id: "a", ts: 1, content: "", toolCalls: [call("c")] },
		{ kind: "tool_result", id: "r", ts: 2, toolCallId: "c", result },
	]);
	const config = { tokenizer: (text: string) => text.length, maxToolResultTokens: 200 };
	const before = await options.sessionStore.load("projection");
	const manager = createContextManager({ ...options, config });
	const first = await manager.project(input);
	const content = first.messages.at(-1)!.content;
	const bounded = JSON.parse(content) as { success: boolean; message: string; artifactId: string };
	expect(content.length).toBeLessThanOrEqual(200);
	expect(content).not.toContain("SECRET_RAW");
	expect(bounded.success).toBe(false);
	expect(bounded.message).toStartWith("operation failed");
	expect(first.messages[0]!.toolCalls).toEqual([call("c")]);
	expect(first.messages[1]!.toolCallId).toBe("c");
	expect((await options.artifactStore.get(bounded.artifactId))!.value).toEqual(result);
	expect((await manager.project(input)).messages).toEqual(first.messages);
	expect((await createContextManager({ ...options, config }).project(input)).messages).toEqual(first.messages);
	expect(await options.artifactStore.list("projection")).toHaveLength(1);
	expect(await options.sessionStore.load("projection")).toEqual(before);
});

 test("entry artifacts are reused only with matching full result identity", async () => {
	const result = { success: true, message: "x".repeat(1000), data: { large: "y".repeat(3000) } };
	const options = await fixture([
		{ kind: "assistant_message", id: "a", ts: 0, content: "", toolCalls: [call("c")] },
		{ kind: "tool_result", id: "r", ts: 1, toolCallId: "c", result, artifactId: "existing" },
	]);
	const record: AgentArtifact = { artifactId: "existing", sessionId: "projection", contentType: "application/json", value: result };
	await options.artifactStore.put(record);
	const config = { maxToolResultTokens: 100, tokenizer: (text: string) => text.length };
	expect(JSON.parse((await createContextManager({ ...options, config }).project(input)).messages[1]!.content).artifactId).toBe("existing");
	expect(await options.artifactStore.list("projection")).toHaveLength(1);
	for (const bad of [null, { ...record, sessionId: "other" }, { ...record, contentType: "text/plain" }, { ...record, value: { success: false, message: "different" } }]) {
		await expect(createContextManager({ ...options, config, artifactStore: { get: async () => bad, put: async () => { throw new Error("unexpected put"); }, list: async () => [] } }).project(input)).rejects.toThrow();
	}
});

 test("cancellation and an impossible artifact marker budget do not persist artifacts", async () => {
	const options = await fixture([
		{ kind: "assistant_message", id: "a", ts: 0, content: "", toolCalls: [call("c")] },
		{ kind: "tool_result", id: "r", ts: 1, toolCallId: "c", result: { success: false, message: "x".repeat(1000) } },
	]);
	await expect(createContextManager({ ...options, config: { maxToolResultTokens: 1, tokenizer: text => text.length } }).project(input)).rejects.toThrow();
	expect(await options.artifactStore.list("projection")).toEqual([]);
	const controller = new AbortController();
	controller.abort();
	await expect(createContextManager(options).project({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	expect(await options.artifactStore.list("projection")).toEqual([]);
	const duringRead = new AbortController();
	const artifactStore = { get: async () => { duringRead.abort(); return null; }, put: options.artifactStore.put.bind(options.artifactStore), list: options.artifactStore.list.bind(options.artifactStore) };
	await expect(createContextManager({ ...options, artifactStore, config: { maxToolResultTokens: 100, tokenizer: text => text.length } }).project({ ...input, signal: duringRead.signal })).rejects.toMatchObject({ name: "AbortError" });
	expect(await options.artifactStore.list("projection")).toEqual([]);
});
