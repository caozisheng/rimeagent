import { describe, expect, test } from "bun:test";
import type { AgentCheckpoint } from "../../src/store/checkpoint";
import type { AgentSessionEntry } from "../../src/store/entries";
import { InMemorySessionStore } from "../../src/store/session-store";

const entry = (id = "entry-1"): Extract<AgentSessionEntry, { kind: "user_message" }> => ({ kind: "user_message", id, ts: 1, content: "hello" });
const checkpoint = (changes: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
	checkpointId: "root", sessionId: "s1", createdAt: 1, entrySeq: 0, contextDigest: "12345678", ...changes,
});

describe("InMemorySessionStore", () => {
	test("returns null for missing sessions and appends entries in insertion order", async () => {
		const store = new InMemorySessionStore();
		expect(await store.load("s1")).toBeNull();
		expect(await store.listCheckpoints("s1")).toEqual([]);
		await store.append("s1", entry("z"));
		await store.append("s1", entry("a"));
		expect(await store.load("s1")).toEqual({ sessionId: "s1", entries: [entry("z"), entry("a")] });
		expect(await store.load("s2")).toBeNull();
	});

	test("rejects per-session duplicates but allows the same entry id across sessions", async () => {
		const store = new InMemorySessionStore();
		await store.append("s1", entry());
		await expect(store.append("s1", { ...entry(), content: "overwrite" })).rejects.toThrow();
		await store.append("s2", entry());
		expect((await store.load("s1"))?.entries).toEqual([entry()]);
		expect((await store.load("s2"))?.entries).toEqual([entry()]);
	});

	test("commits exactly one concurrent duplicate append", async () => {
		const store = new InMemorySessionStore();
		const results = await Promise.allSettled([store.append("s1", entry()), store.append("s1", entry())]);
		expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
		expect((await store.load("s1"))?.entries).toEqual([entry()]);
	});

	test("isolates nested append inputs and every returned snapshot", async () => {
		const store = new InMemorySessionStore();
		const input: AgentSessionEntry = {
			kind: "assistant_message", id: "a", ts: 1, content: "answer",
			toolCalls: [{ id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }],
		};
		await store.append("s1", input);
		input.toolCalls![0]!.function.name = "mutated";
		const first = (await store.load("s1"))!;
		const assistant = first.entries[0]!;
		if (assistant.kind !== "assistant_message") throw new Error("Expected assistant entry");
		expect(assistant.toolCalls![0]!.function.name).toBe("lookup");
		assistant.toolCalls![0]!.function.arguments = "changed";
		first.entries.pop();
		const next = (await store.load("s1"))!;
		expect(next.entries).toHaveLength(1);
		expect(next.entries[0]).toMatchObject({ toolCalls: [{ function: { arguments: "{}", name: "lookup" } }] });
	});

	test("strips opaque error causes before storing without retaining credentials", async () => {
		const store = new InMemorySessionStore();
		const cause: Record<string, unknown> = { apiKey: "do-not-persist", request: new Uint8Array([1]) };
		cause.self = cause;
		await store.append("s1", {
			kind: "error", id: "err", ts: 1,
			error: { category: "provider", message: "failed", retryable: true, cause },
		});
		const loaded = await store.load("s1");
		expect(loaded?.entries).toEqual([{
			kind: "error", id: "err", ts: 1, error: { category: "provider", message: "failed", retryable: true },
		}]);
		expect(JSON.stringify(loaded)).not.toContain("do-not-persist");
	});

	test("invalid append neither establishes a session nor reserves an entry id", async () => {
		const store = new InMemorySessionStore();
		const invalid: unknown = { ...entry(), apiKey: "secret" };
		await expect(store.append("s1", invalid as AgentSessionEntry)).rejects.toThrow();
		expect(await store.load("s1")).toBeNull();
		await store.append("s1", entry());
		await expect(store.append("", entry())).rejects.toThrow();
		await expect(store.load("")).rejects.toThrow();
		await expect(store.listCheckpoints("")).rejects.toThrow();
	});

	test("root checkpoint zero establishes an empty session", async () => {
		const store = new InMemorySessionStore();
		await store.saveCheckpoint(checkpoint());
		expect(await store.load("s1")).toEqual({ sessionId: "s1", entries: [] });
		expect(await store.listCheckpoints("s1")).toEqual([checkpoint()]);
		await store.append("s1", entry());
		expect((await store.load("s1"))?.entries).toEqual([entry()]);
	});

	test("accepts same-session checkpoint chains and branches in stable insertion order", async () => {
		const store = new InMemorySessionStore();
		await store.append("s1", entry());
		const root = checkpoint();
		const child = checkpoint({ checkpointId: "z-child", parentId: "root", entrySeq: 1 });
		const sibling = checkpoint({ checkpointId: "a-sibling", parentId: "root", entrySeq: 0 });
		await store.saveCheckpoint(root);
		await store.saveCheckpoint(child);
		await store.saveCheckpoint(sibling);
		expect(await store.listCheckpoints("s1")).toEqual([root, child, sibling]);
		expect(await store.listCheckpoints("s2")).toEqual([]);
	});

	test("isolates checkpoint inputs and list results", async () => {
		const store = new InMemorySessionStore();
		const input = { ...checkpoint() };
		await store.saveCheckpoint(input);
		input.contextDigest = "changed";
		const results = await store.listCheckpoints("s1");
		Reflect.set(results[0]!, "contextDigest", "mutated");
		results.pop();
		expect(await store.listCheckpoints("s1")).toEqual([checkpoint()]);
	});

	test("preserves isolated recovery and opaque state bindings on durable checkpoints", async () => {
		const store = new InMemorySessionStore();
		const input = checkpoint({ runId: "run-1", seq: 12, externalStateBinding: { scopeId: "resource", version: "etag-A" } });
		await store.saveCheckpoint(input);
		Reflect.set(input, "externalStateBinding", { scopeId: "resource", version: "etag-B" });
		const saved = (await store.listCheckpoints("s1"))[0]!;
		expect(saved).toMatchObject({ runId: "run-1", seq: 12, externalStateBinding: { scopeId: "resource", version: "etag-A" } });
		Reflect.set(saved, "seq", 999);
		expect((await store.listCheckpoints("s1"))[0]!.seq).toBe(12);
	});

	test("checkpoint ids are globally unique, including concurrent writes", async () => {
		const store = new InMemorySessionStore();
		const results = await Promise.allSettled([
			store.saveCheckpoint(checkpoint()), store.saveCheckpoint(checkpoint({ sessionId: "s2" })),
		]);
		expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
		expect(await store.load("s2")).toBeNull();
		expect(await store.listCheckpoints("s1")).toEqual([checkpoint()]);
	});

	test("rejects missing and cross-session parents without creating a session", async () => {
		const store = new InMemorySessionStore();
		await expect(store.saveCheckpoint(checkpoint({ parentId: "missing" }))).rejects.toThrow();
		expect(await store.load("s1")).toBeNull();
		await store.saveCheckpoint(checkpoint());
		await expect(store.saveCheckpoint(checkpoint({ checkpointId: "child", sessionId: "s2", parentId: "root" })))
			.rejects.toThrow();
		expect(await store.load("s2")).toBeNull();
	});

	test("rejects checkpoints past the current boundary or before their parent", async () => {
		const store = new InMemorySessionStore();
		await expect(store.saveCheckpoint(checkpoint({ entrySeq: 1 }))).rejects.toThrow();
		expect(await store.load("s1")).toBeNull();
		await store.append("s1", entry());
		await expect(store.saveCheckpoint(checkpoint({ entrySeq: 2 }))).rejects.toThrow();
		await store.saveCheckpoint(checkpoint({ entrySeq: 1 }));
		await expect(store.saveCheckpoint(checkpoint({ checkpointId: "child", parentId: "root", entrySeq: 0 })))
			.rejects.toThrow();
		expect(await store.listCheckpoints("s1")).toEqual([checkpoint({ entrySeq: 1 })]);
	});

	test.each([
		{ checkpointId: "" }, { sessionId: "" }, { parentId: "" }, { entrySeq: -1 }, { entrySeq: 0.5 },
		{ entrySeq: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: NaN }, { createdAt: -1 },
		{ contextDigest: "" }, { apiKey: "secret" },
		{ runId: "" }, { seq: 0 }, { seq: 1.5 }, { externalStateBinding: { scopeId: "", version: "v" } }, { externalStateBinding: { scopeId: "s", version: "" } },
	])("rejects malformed checkpoint fields: %j", async changes => {
		const store = new InMemorySessionStore();
		await expect(store.saveCheckpoint(checkpoint(changes))).rejects.toThrow();
		expect(await store.load("s1")).toBeNull();
	});

	test("rejects checkpoint accessors and inherited data without running getters", async () => {
		const store = new InMemorySessionStore();
		let reads = 0;
		const input = Object.defineProperty(checkpoint(), "entrySeq", {
			enumerable: true, get() { reads++; return 0; },
		});
		await expect(store.saveCheckpoint(input)).rejects.toThrow();
		await expect(store.saveCheckpoint(Object.create(checkpoint()))).rejects.toThrow();
		expect(reads).toBe(0);
		expect(await store.load("s1")).toBeNull();
	});
});
