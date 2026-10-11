import { describe, expect, test } from "bun:test";
import type { AgentArtifact } from "../../src/store/artifact-store";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";

const artifact = (changes: Partial<AgentArtifact> = {}): AgentArtifact => ({
	artifactId: "a1", sessionId: "s1", contentType: "application/json", value: { items: [{ name: "original" }] },
	...changes,
});

describe("InMemoryArtifactStore", () => {
	test("returns null and empty lists for unknown ids and sessions", async () => {
		const store = new InMemoryArtifactStore();
		expect(await store.get("unknown")).toBeNull();
		expect(await store.list("s1")).toEqual([]);
	});

	test("rejects globally duplicate ids without overwriting or changing session ownership", async () => {
		const store = new InMemoryArtifactStore();
		await store.put(artifact());
		await expect(store.put(artifact({ sessionId: "s2", value: "changed" }))).rejects.toThrow();
		expect(await store.get("a1")).toEqual(artifact());
		expect(await store.list("s2")).toEqual([]);
	});

	test("commits exactly one concurrent duplicate put", async () => {
		const store = new InMemoryArtifactStore();
		const outcomes = await Promise.allSettled([store.put(artifact()), store.put(artifact({ value: "changed" }))]);
		expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
		expect(await store.get("a1")).toEqual(artifact());
	});

	test("isolates nested input, get results, and list results", async () => {
		const store = new InMemoryArtifactStore();
		const input = { artifactId: "a1", sessionId: "s1", contentType: "application/json", value: { items: [{ name: "original" }] } };
		await store.put(input);
		input.value.items[0]!.name = "input-mutated";
		const first = (await store.get("a1"))!;
		Reflect.set(first.value as object, "items", ["get-mutated"]);
		const list = await store.list("s1");
		Reflect.set(list[0]!.value as object, "items", ["list-mutated"]);
		Reflect.set(list[0]!, "contentType", "changed");
		list.pop();
		expect(await store.get("a1")).toEqual(artifact());
		expect(await store.list("s1")).toEqual([artifact()]);
	});

	test("filters sessions and retains insertion order rather than sorting identifiers", async () => {
		const store = new InMemoryArtifactStore();
		const first = artifact({ artifactId: "z" });
		const other = artifact({ artifactId: "other", sessionId: "s2" });
		const last = artifact({ artifactId: "a" });
		await store.put(first);
		await store.put(other);
		await store.put(last);
		expect(await store.list("s1")).toEqual([first, last]);
		expect(await store.list("s2")).toEqual([other]);
	});

	test("accepts JSON primitives and omits nested optional undefined object fields", async () => {
		const store = new InMemoryArtifactStore();
		const values = [null, true, 1.25, "text", [1, "x"], { nested: { keep: "yes", omit: undefined } }];
		for (const [index, value] of values.entries()) {
			await store.put(artifact({ artifactId: `a${index}`, value }));
		}
		expect((await store.get("a5"))?.value).toEqual({ nested: { keep: "yes" } });
		expect(JSON.stringify((await store.get("a5"))?.value)).toBe('{"nested":{"keep":"yes"}}');
	});

	test.each([
		undefined, NaN, Infinity, -Infinity, 1n, () => "x", Symbol("x"),
		new Uint8Array([1]), new Date(0), new Map(), new Set(), [undefined], new Array(1),
		{ nested: { bad: Infinity } }, { toJSON() { return "hidden"; } }, Object.create({ inherited: 1 }),
	])("rejects unsupported JSON without reserving artifact ids: row %#", async value => {
		const store = new InMemoryArtifactStore();
		const input = { ...artifact(), value } as AgentArtifact;
		await expect(store.put(input)).rejects.toThrow();
		expect(await store.get("a1")).toBeNull();
		await store.put(artifact());
		expect(await store.get("a1")).toEqual(artifact());
	});

	test("rejects cycles and accessors without invoking getters", async () => {
		const store = new InMemoryArtifactStore();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		let reads = 0;
		const getter = Object.defineProperty({}, "secret", {
			enumerable: true, get() { reads++; return "credentials"; },
		});
		for (const value of [cycle, getter]) {
			await expect(store.put({ ...artifact(), value } as AgentArtifact)).rejects.toThrow();
		}
		const input = Object.defineProperty(artifact(), "value", {
			enumerable: true, get() { reads++; return null; },
		});
		await expect(store.put(input)).rejects.toThrow();
		expect(reads).toBe(0);
		expect(await store.list("s1")).toEqual([]);
	});

	test.each([
		{ artifactId: "" }, { sessionId: "" }, { contentType: "" }, { contentType: 1 },
		{ apiKey: "secret" },
	])("rejects invalid identifiers and unknown record fields: %j", async changes => {
		const store = new InMemoryArtifactStore();
		await expect(store.put({ ...artifact(), ...changes } as AgentArtifact)).rejects.toThrow();
		expect(await store.list("s1")).toEqual([]);
	});

	test("requires own fields and validates lookup identifiers", async () => {
		const store = new InMemoryArtifactStore();
		await expect(store.put(Object.create(artifact()))).rejects.toThrow();
		await expect(store.put({ artifactId: "a1", sessionId: "s1", contentType: "application/json" } as AgentArtifact))
			.rejects.toThrow();
		await expect(store.get("")).rejects.toThrow();
		await expect(store.list("")).rejects.toThrow();
	});
});
