import { expect, test } from "bun:test";
import { createContextManager } from "../../src/runtime/context-manager";
import type { ContextSummary, SummarizeContextInput, ContextSummarizer } from "../../src/runtime/context-manager";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemorySessionStore } from "../../src/store/session-store";
import type { AgentSessionEntry } from "../../src/store/entries";
import { RuntimeHistory, projectMessages } from "../../src/runtime/history";
import { computeContextDigest } from "../../src/store/checkpoint";

const llmConfig = { baseUrl: "https://compaction.invalid", apiKey: "secret", model: "compaction" };
const facts = { projectRevision: 7, digest: "current-project", summary: "Current project truth", producedBy: "host" as const };
const input = { llmConfig, systemPrompt: "instructions", tools: [], projectFacts: facts, forceCompact: true };
const summary: ContextSummary = { goal: "Keep editing", constraints: ["Do not lose user intent"], completedEdits: ["old edit"], decisions: [], failedTools: [], openQuestions: [], nextSteps: ["latest request"], references: ["artifact:old"] };
async function fixture(turns = 3) {
	const sessionStore = new InMemorySessionStore();
	const artifactStore = new InMemoryArtifactStore();
	const sessionId = "compaction";
	const history = new RuntimeHistory(sessionStore, sessionId);
	for (let turn = 0; turn < turns; turn++) {
		await history.append({ kind: "user_message", content: `goal ${turn} ` + "u".repeat(200) });
		await history.append({ kind: "assistant_message", content: "", toolCalls: [{ id: `call-${turn}`, type: "function", function: { name: "edit", arguments: "{}" } }] });
		await history.append({ kind: "tool_result", toolCallId: `call-${turn}`, result: { success: true, message: `edit ${turn}` } });
		await history.checkpoint();
		await history.append({ kind: "assistant_message", content: `completed ${turn}` });
		await history.checkpoint();
	}
	return { sessionId, sessionStore, artifactStore, history };
}

 test("55 turns compact only checkpoint-safe complete atoms while retaining latest user, calls and current facts", async () => {
	const options = await fixture(55);
	const before = (await options.sessionStore.load(options.sessionId))!.entries;
	const calls: SummarizeContextInput[] = [];
	const manager = createContextManager({ ...options, config: { contextTokens: 4096 }, summarize: value => { calls.push(value); return summary; } });
	const projected = await manager.project(input);
	expect(projected.compacted).toBe(true);
	expect(projected.messages.slice(0, 2).map(message => message.role)).toEqual(["system", "system"]);
	expect(projected.messages[0]!.content).toContain("Current project truth");
	expect(projected.messages[1]!.content).toContain("Historical");
	expect(projected.messages.find(message => message.role === "user")!.content).toStartWith("goal 54");
	expect(projected.messages.find(message => message.toolCalls)?.toolCalls![0]!.id).toBe("call-54");
	expect(projected.messages.find(message => message.role === "tool")!.toolCallId).toBe("call-54");
	expect(calls).toHaveLength(1);
	expect(calls[0]!.projectFacts).toEqual(facts);
	expect(calls[0]!.messages.some(message => message.content.startsWith("goal 54"))).toBe(false);
	const after = (await options.sessionStore.load(options.sessionId))!.entries;
	expect(after.slice(0, before.length)).toEqual(before);
	const compacted = after.at(-1)!;
	expect(compacted.kind).toBe("compaction");
	if (compacted.kind !== "compaction") throw new Error("Missing compaction");
	expect(compacted.compactedEntryIds).toEqual(projectMessages(before).slice(0, -4).map(message => message.id));
	expect(projected.compaction!.droppedEntries).toBe(compacted.compactedEntryIds.length);
	const checkpoint = (await options.sessionStore.listCheckpoints(options.sessionId)).at(-1)!;
	expect(computeContextDigest(projectMessages(after.slice(0, checkpoint.entrySeq)))).toBe(checkpoint.contextDigest);
});

 test("repeated compaction accumulates prefix IDs and supplies previous summary without replaying it as authoritative facts", async () => {
	const options = await fixture();
	const calls: SummarizeContextInput[] = [];
	const summarize: ContextSummarizer = value => { calls.push(value); return { ...summary, completedEdits: [`summary ${calls.length}`] }; };
	await createContextManager({ ...options, summarize }).project(input);
	const first = (await options.sessionStore.load(options.sessionId))!.entries.at(-1)!;
	await options.history.append({ kind: "user_message", content: "new goal" });
	await options.history.append({ kind: "assistant_message", content: "", toolCalls: [{ id: "new-call", type: "function", function: { name: "edit", arguments: "{}" } }] });
	await options.history.append({ kind: "tool_result", toolCallId: "new-call", result: { success: true, message: "new edit" } });
	await options.history.append({ kind: "assistant_message", content: "new complete response" });
	await options.history.checkpoint();
	const freshFacts = { ...facts, projectRevision: 8, digest: "fresh", summary: "Fresh host truth" };
	const second = await createContextManager({ ...options, summarize }).project({ ...input, projectFacts: freshFacts });
	const entries = (await options.sessionStore.load(options.sessionId))!.entries;
	const latest = entries.at(-1)!;
	if (first.kind !== "compaction" || latest.kind !== "compaction") throw new Error("Missing compactions");
	expect(latest.compactedEntryIds.slice(0, first.compactedEntryIds.length)).toEqual(first.compactedEntryIds);
	expect(latest.compactedEntryIds.length).toBeGreaterThan(first.compactedEntryIds.length);
	expect(calls[1]!.previousSummary!.completedEdits).toEqual(["summary 1"]);
	expect(calls[1]!.messages.some(message => first.compactedEntryIds.includes(message.id))).toBe(false);
	expect(second.messages[0]!.content).toContain("Fresh host truth");
	expect(second.messages[0]!.content).not.toContain("summary 1");
	expect(second.messages[1]!.content).toContain("summary 2");
	const reopened = await createContextManager({ ...options, summarize }).project({ ...input, projectFacts: freshFacts, forceCompact: false });
	expect(reopened.messages).toEqual(second.messages);
	expect(reopened.compacted).toBe(false);
});

test("a trailing pending batch cannot displace protection of the latest complete batch", async () => {
	const options = await fixture(0);
	await options.history.append({ kind: "assistant_message", content: "old standalone" });
	await options.history.checkpoint();
	await options.history.append({ kind: "assistant_message", content: "", toolCalls: [{ id: "complete", type: "function", function: { name: "inspect", arguments: "{}" } }] });
	await options.history.append({ kind: "tool_result", toolCallId: "complete", result: { success: true, message: "done" } });
	await options.history.checkpoint();
	await options.history.append({ kind: "assistant_message", content: "", toolCalls: [{ id: "pending", type: "function", function: { name: "inspect", arguments: "{}" } }] });
	const projected = await createContextManager({ ...options, summarize: () => summary }).project(input);
	expect(projected.messages.filter(message => message.role === "assistant").map(message => message.toolCalls![0]!.id)).toEqual(["complete", "pending"]);
	expect(projected.messages.find(message => message.role === "tool")!.toolCallId).toBe("complete");
});

 test("without current facts, host summarizer or a safe checkpoint there is no fake compaction", async () => {
	for (const absent of ["facts", "summarizer", "checkpoint"] as const) {
		const options = await fixture();
		const before = await options.sessionStore.load(options.sessionId);
		const store = absent === "checkpoint" ? { load: options.sessionStore.load.bind(options.sessionStore), append: options.sessionStore.append.bind(options.sessionStore), saveCheckpoint: options.sessionStore.saveCheckpoint.bind(options.sessionStore), listCheckpoints: async () => [] } : options.sessionStore;
		const manager = createContextManager({ ...options, sessionStore: store, ...(absent === "summarizer" ? {} : { summarize: () => summary }) });
		const projected = await manager.project({ ...input, ...(absent === "facts" ? { projectFacts: undefined } : {}) });
		expect(projected.compacted).toBe(false);
		expect(projected.messages.filter(message => message.role !== "system")).toEqual(projectMessages(before!.entries));
		expect(await options.sessionStore.load(options.sessionId)).toEqual(before);
	}
});

 test("required summary fields, nonempty goal and oversized summary fail before history append", async () => {
	const options = await fixture();
	const before = await options.sessionStore.load(options.sessionId);
	const invalid: unknown[] = [{}, { ...summary, goal: "" }, { ...summary, constraints: "wrong" }, { ...summary, goal: "x".repeat(20000) }, { ...summary, unapproved: true }];
	for (const field of Object.keys(summary)) {
		const partial = { ...summary } as Record<string, unknown>;
		delete partial[field];
		invalid.push(partial);
	}
	for (const value of invalid) {
		const manager = createContextManager({ ...options, config: { contextTokens: 2048, tokenizer: text => text.length }, summarize: () => value as ContextSummary });
		await expect(manager.project(input)).rejects.toThrow();
		expect(await options.sessionStore.load(options.sessionId)).toEqual(before);
	}
});

test("invalid host summary does not commit staged oversized tool artifacts", async () => {
	const options = await fixture();
	await options.history.append({ kind: "assistant_message", content: "", toolCalls: [{ id: "large-call", type: "function", function: { name: "inspect", arguments: "{}" } }] });
	await options.history.append({ kind: "tool_result", toolCallId: "large-call", result: { success: false, message: "failed " + "x".repeat(10000), data: { private: "SECRET".repeat(10000) } } });
	await options.history.checkpoint();
	await options.history.append({ kind: "user_message", content: "latest goal" });
	await options.history.append({ kind: "assistant_message", content: "", toolCalls: [{ id: "latest-call", type: "function", function: { name: "inspect", arguments: "{}" } }] });
	await options.history.append({ kind: "tool_result", toolCallId: "latest-call", result: { success: true, message: "latest" } });
	await options.history.checkpoint();
	const before = await options.sessionStore.load(options.sessionId);
	let summaryInput: SummarizeContextInput | undefined;
	const manager = createContextManager({ ...options, config: { maxToolResultTokens: 200, tokenizer: text => text.length }, summarize: value => { summaryInput = value; return { ...summary, goal: "" }; } });
	await expect(manager.project(input)).rejects.toThrow();
	expect(summaryInput).toBeDefined();
	expect(JSON.stringify(summaryInput!.messages)).not.toContain("SECRET");
	expect(JSON.parse(summaryInput!.messages.at(-1)!.content)).toMatchObject({ success: false, artifactId: expect.any(String) });
	expect(await options.sessionStore.load(options.sessionId)).toEqual(before);
	expect(await options.artifactStore.list(options.sessionId)).toEqual([]);
});

 test("cancellation, summarizer errors and storage failures preserve historical entries", async () => {
	const options = await fixture();
	const before = await options.sessionStore.load(options.sessionId);
	const controller = new AbortController();
	await expect(createContextManager({ ...options, summarize: () => { controller.abort(); return summary; } }).project({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	expect(await options.sessionStore.load(options.sessionId)).toEqual(before);
	await expect(createContextManager({ ...options, summarize: () => { throw new Error("summarizer failed"); } }).project(input)).rejects.toMatchObject({ category: "provider", message: "summarizer failed" });
	const failure = new Error("storage abort");
	const sessionStore = { load: options.sessionStore.load.bind(options.sessionStore), append: async () => { throw failure; }, saveCheckpoint: options.sessionStore.saveCheckpoint.bind(options.sessionStore), listCheckpoints: options.sessionStore.listCheckpoints.bind(options.sessionStore) };
	await expect(createContextManager({ ...options, sessionStore, summarize: () => summary }).project(input)).rejects.toBe(failure);
	expect(await options.sessionStore.load(options.sessionId)).toEqual(before);
});

 test("persisted summaries cannot hide non-prefix, future or partial tool groups", async () => {
	for (const mode of ["nonprefix", "future", "partial"] as const) {
		const options = await fixture();
		const messages = projectMessages((await options.sessionStore.load(options.sessionId))!.entries);
		const ids = mode === "nonprefix" ? [messages[1]!.id] : mode === "future" ? ["future-id"] : messages.slice(0, 2).map(message => message.id);
		const entry: AgentSessionEntry = { kind: "compaction", id: "corrupt", ts: 0, summary: JSON.stringify(summary), compactedEntryIds: ids, projectDigest: facts };
		await options.sessionStore.append(options.sessionId, entry);
		await expect(createContextManager({ ...options, summarize: () => summary }).project(input)).rejects.toThrow();
	}
});
