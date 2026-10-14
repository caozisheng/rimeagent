import { describe, expect, test } from "bun:test";
import { createAgentRuntime, InMemorySessionStore, registerLLMBackendFor } from "../../src/index";
import type { AgentRuntimeConfig, DurableAgentTool, LLMBackend, OpenAIMessage, StreamChunk, ToolCall } from "../../src/index";
import type { AgentSessionEntry } from "../../src/store/entries";

interface EventShape {
	readonly v: number;
	readonly runId: string;
	readonly seq: number;
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

type Turn = (messages: OpenAIMessage[], signal: AbortSignal | undefined, request: number) => AsyncGenerator<StreamChunk>;

async function collectEvents(stream: AsyncGenerator<unknown>): Promise<EventShape[]> {
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return events as EventShape[];
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
	return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function textTurn(text: string): Turn {
	return async function* () {
		yield { type: "content_delta", delta: text };
		yield { type: "done" };
	};
}

function toolTurn(toolCalls: ToolCall[]): Turn {
	return async function* () {
		yield { type: "tool_calls_complete", toolCalls };
		yield { type: "done" };
	};
}

function installBackend(model: string, turn: Turn): { requests: () => number; dispose: () => void } {
	let requests = 0;
	const backend: LLMBackend = {
		type: "lifecycle-test",
		async *streamChat(_config, messages, signal, _tools) {
			requests++;
			yield* turn(messages, signal, requests);
		},
	};
	const dispose = registerLLMBackendFor(config => config.model === model, backend);
	return { requests: () => requests, dispose };
}

function runtimeConfig(model: string, store: InMemorySessionStore, extra: Partial<AgentRuntimeConfig> = {}) {
	return {
		...extra,
		sessionId: `session-${model}`,
		llmConfig: { baseUrl: "https://lifecycle.invalid", apiKey: "test-key", model, provider: "custom" as const },
		expertRoleId: "general",
		sessionStore: store,
		tools: extra.tools ?? [],
	};
}

function types(events: EventShape[]): string[] {
	return events.map(event => event.type);
}

function payload(events: EventShape[], type: string): Record<string, unknown> {
	const event = events.find(candidate => candidate.type === type);
	if (!event) throw new Error(`Missing ${type} event`);
	return event.payload;
}


describe("AgentRuntime lifecycle", () => {
	test("emits a v2 text completion with one iteration", async () => {
		const model = "lifecycle-text";
		const store = new InMemorySessionStore();
		const mock = installBackend(model, textTurn("hello"));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			const events = await collectEvents(runtime.run("say hello"));
			expect(types(events)).toEqual([
				"run_started", "iteration_start", "status", "text_delta", "message_end", "iteration_end", "run_completed",
			]);
			expect(events.every(event => event.v === 2)).toBe(true);
			expect(payload(events, "run_completed")).toMatchObject({ reason: "response", iterations: 1 });
			expect(runtime.state).toBe("settled");
		} finally {
			mock.dispose();
		}
	});

	test("retains history across same-session runs and gives each run an independent id", async () => {
		const model = "lifecycle-history";
		const store = new InMemorySessionStore();
		const seen: OpenAIMessage[][] = [];
		const mock = installBackend(model, async function* (messages, _signal, request) {
			seen.push(messages);
			yield* textTurn(request === 1 ? "first answer" : "second answer")(messages, undefined, request);
		});
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			const first = await collectEvents(runtime.run("first question"));
			const second = await collectEvents(runtime.run("second question"));
			expect(first[0].runId).not.toBe(second[0].runId);
			expect(seen[1].slice(1).map(message => message.content)).toEqual([
				expect.stringContaining("first question"),
				expect.stringContaining("first answer"),
				expect.stringContaining("second question"),
			]);
			const snapshot = await store.load(`session-${model}`);
			expect(snapshot?.entries.filter(entry => entry.kind === "user_message").map(entry => entry.content))
				.toEqual(["first question", "second question"]);
		} finally {
			mock.dispose();
		}
	});

	test("maxIterations one executes one tool batch and completes observably", async () => {
		const model = "lifecycle-cap";
		const store = new InMemorySessionStore();
		let executions = 0;
		const tool: DurableAgentTool = {
			name: "once",
			description: "once",
			parameters: { type: "object", properties: {} },
			execute: async () => { executions++; return { result: { success: true, message: "ok" } }; },
		};
		const mock = installBackend(model, toolTurn([call("call-once", "once")]));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store, { tools: [tool], maxIterations: 1 }));
			const events = await collectEvents(runtime.run("run once"));
			expect(mock.requests()).toBe(1);
			expect(executions).toBe(1);
			expect(payload(events, "run_completed")).toMatchObject({ reason: "max_iterations", iterations: 1 });
		} finally {
			mock.dispose();
		}
	});

	test("executes tools serially and invokes tool-failure recovery on the next iteration", async () => {
		const model = "lifecycle-recovery";
		const store = new InMemorySessionStore();
		const order: string[] = [];
		const failures: string[] = [];
		const seenSystemPrompts: string[] = [];
		const tools: DurableAgentTool[] = ["first", "second"].map((name, index) => ({
			name,
			description: name,
			parameters: { type: "object", properties: {} },
			execute: async () => {
				order.push(name);
				return { result: index === 0 ? { success: false, message: "first failed" } : { success: true, message: "second ok" } };
			},
		}));
		const mock = installBackend(model, async function* (messages, _signal, request) {
			seenSystemPrompts.push(String(messages[0]?.content));
			yield* (request === 1 ? toolTurn([call("call-first", "first"), call("call-second", "second")]) : textTurn("recovered"))
				(messages, undefined, request);
		});
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store, {
			tools,
			maxIterations: 3,
			hooks: { buildErrorRecovery: received => { failures.push(...received.map(failure => failure.toolName)); return "recover-context"; } },
			}));
			const events = await collectEvents(runtime.run("use both"));
			expect(order).toEqual(["first", "second"]);
			expect(failures).toEqual(["first"]);
			expect(seenSystemPrompts[1]).toContain("recover-context");
			expect(payload(events, "run_completed")).toMatchObject({ reason: "response", iterations: 2 });
		} finally {
			mock.dispose();
		}
	});

	test("abort writes interruption and checkpoint, releases the run lock, and permits resume", async () => {
		const model = "lifecycle-abort";
		const store = new InMemorySessionStore();
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const mock = installBackend(model, async function* (_messages, signal, request) {
			if (request === 1) {
				started.resolve();
				signal?.addEventListener("abort", () => released.resolve(), { once: true });
				await released.promise;
				return;
			}
			yield* textTurn("after abort")(_messages, signal, request);
		});
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			const stream = runtime.run("cancel me");
			const runStarted = await stream.next();
			const remaining = collectEvents(stream);
			await started.promise;
			runtime.abort("user canceled");
			const events = [runStarted.value as unknown as EventShape, ...(await remaining)];
			expect(types(events)).toContain("run_interrupted");
			expect(runtime.state).toBe("interrupted");
			const snapshot = await store.load(`session-${model}`);
			expect(snapshot?.entries.some(entry => entry.kind === "run_interrupted")).toBe(true);
			expect((await store.listCheckpoints(`session-${model}`)).length).toBeGreaterThan(0);
			await collectEvents(runtime.resume(events[0].runId));
			expect(mock.requests()).toBe(2);
		} finally {
			mock.dispose();
		}
	});

	test("pre-aborted runs do not call the model or tools and can be resumed", async () => {
		const model = "lifecycle-preabort";
		const store = new InMemorySessionStore();
		const controller = new AbortController();
		controller.abort();
		let toolCalls = 0;
		const tool: DurableAgentTool = { name: "never", description: "never", parameters: { type: "object", properties: {} }, execute: async () => {
			toolCalls++;
			return { result: { success: true, message: "unexpected" } };
		} };
		const mock = installBackend(model, textTurn("allowed later"));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store, { tools: [tool] }));
			const events = await collectEvents(runtime.run("already canceled", controller.signal));
			expect(types(events)).toContain("run_interrupted");
			expect(mock.requests()).toBe(0);
			expect(toolCalls).toBe(0);
			expect(runtime.state).toBe("interrupted");
			await collectEvents(runtime.resume(events[0].runId));
			expect(mock.requests()).toBe(1);
		} finally {
			mock.dispose();
		}
	});

	test("early generator return persists interruption and checkpoint without yielding a fake terminal event", async () => {
		const model = "lifecycle-early-return";
		const store = new InMemorySessionStore();
		const mock = installBackend(model, textTurn("never requested"));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			const stream = runtime.run("close me");
			const first = await stream.next();
			expect(first.value && (first.value as unknown as EventShape).type).toBe("run_started");
			await stream.return(undefined);
			expect(runtime.state).toBe("interrupted");
			const snapshot = await store.load(`session-${model}`);
			expect(snapshot?.entries.some(entry => entry.kind === "run_interrupted")).toBe(true);
			expect((await store.listCheckpoints(`session-${model}`)).length).toBeGreaterThan(0);
			await collectEvents(runtime.resume((first.value as EventShape).runId));
			expect(mock.requests()).toBe(1);
		} finally {
			mock.dispose();
		}
	});

	test("rejects a reentrant run before adding its user message or calling the model", async () => {
		const model = "lifecycle-reentrant";
		const store = new InMemorySessionStore();
		const mock = installBackend(model, textTurn("first only"));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			const first = runtime.run("first");
			await first.next();
			const second = runtime.run("second");
			await expect(second.next()).rejects.toThrow();
			await first.return(undefined);
			const snapshot = await store.load(`session-${model}`);
			expect(snapshot?.entries.filter(entry => entry.kind === "user_message").map(entry => entry.content)).toEqual(["first"]);
			expect(mock.requests()).toBe(0);
		} finally {
			mock.dispose();
		}
	});

	test("waits for an in-flight tool, records it, then stops without another tool or model request", async () => {
		const model = "lifecycle-tool-abort";
		const store = new InMemorySessionStore();
		const toolStarted = Promise.withResolvers<void>();
		const toolReleased = Promise.withResolvers<void>();
		const calls: string[] = [];
		const tools: DurableAgentTool[] = ["slow", "later"].map(name => ({
			name,
			description: name,
			parameters: { type: "object", properties: {} },
			execute: async () => {
				calls.push(name);
				if (name === "slow") { toolStarted.resolve(); await toolReleased.promise; }
				return { result: { success: true, message: name } };
			},
		}));
		const mock = installBackend(model, toolTurn([call("call-slow", "slow"), call("call-later", "later")]));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store, { tools }));
			const controller = new AbortController();
			const stream = runtime.run("cancel tool", controller.signal);
			const draining = collectEvents(stream);
			await toolStarted.promise;
			controller.abort();
			toolReleased.resolve();
			const events = await draining;
			expect(calls).toEqual(["slow"]);
			expect(mock.requests()).toBe(1);
			expect(types(events)).toContain("run_interrupted");
			expect(types(events)).not.toContain("tool_result");
			const snapshot = await store.load(`session-${model}`);
			expect(snapshot?.entries.filter(entry => entry.kind === "tool_result").map(entry => entry.toolCallId)).toEqual(["call-slow"]);
		} finally {
			mock.dispose();
		}
	});

	test("persists model failures as sanitized run_failed errors", async () => {
		const model = "lifecycle-model-error";
		const store = new InMemorySessionStore();
		const mock = installBackend(model, async function* () {
			throw new Error("provider exploded", { cause: { apiKey: "must not persist" } });
		});
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			const events = await collectEvents(runtime.run("fail"));
			const failed = payload(events, "run_failed").error as Record<string, unknown>;
			expect(failed.category).toBe("provider");
			expect(Object.hasOwn(failed, "cause")).toBe(false);
			const snapshot = await store.load(`session-${model}`);
			const entry = snapshot?.entries.find(candidate => candidate.kind === "run_failed");
			expect(entry?.kind === "run_failed" && Object.hasOwn(entry.error, "cause")).toBe(false);
		} finally {
			mock.dispose();
		}
	});

	test("checkpoint references the boundary at which its checkpoint entry is appended", async () => {
		const model = "lifecycle-checkpoint";
		const store = new InMemorySessionStore();
		const mock = installBackend(model, textTurn("checkpointed"));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, store));
			await collectEvents(runtime.run("save boundary"));
			const reference = await runtime.checkpoint("manual");
			const snapshot = await store.load(`session-${model}`);
			const entryIndex = snapshot?.entries.findIndex(entry => entry.kind === "checkpoint" && entry.checkpointId === reference.checkpointId);
			expect(entryIndex).toBeGreaterThanOrEqual(0);
			const checkpoints = await store.listCheckpoints(`session-${model}`);
			const persisted = checkpoints.find(checkpoint => checkpoint.checkpointId === reference.checkpointId);
			expect(persisted?.entrySeq).toBe(entryIndex);
			expect(persisted?.label).toBe("manual");
		} finally {
			mock.dispose();
		}
	});

	test("propagates session-store append failures instead of fabricating run_failed", async () => {
		class AppendFailureStore extends InMemorySessionStore {
			private failed = false;

			override async append(sessionId: string, entry: AgentSessionEntry): Promise<void> {
				if (!this.failed) {
					this.failed = true;
					throw new Error("append unavailable");
				}
				await super.append(sessionId, entry);
			}
		}
		const model = "lifecycle-store-error";
		const mock = installBackend(model, textTurn("not reached"));
		try {
			const runtime = createAgentRuntime(runtimeConfig(model, new AppendFailureStore()));
			await expect(collectEvents(runtime.run("persist me"))).rejects.toThrow("append unavailable");
			expect(runtime.state).not.toBe("running");
			expect(mock.requests()).toBe(0);
		} finally {
			mock.dispose();
		}
	});
});
