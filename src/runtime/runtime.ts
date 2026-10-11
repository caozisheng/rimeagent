import { nanoid } from "nanoid";
import type { AgentLLMConfig, AgentMessage, ToolCall, ToolDefinition } from "../types";
import type { AgentTool } from "../tool-types";
import type { PromptLayer } from "../prompt-builder";
import type { RagBuilder, ErrorRecoveryBuilder } from "../rag-types";
import type { AgentSessionConfig, AgentSessionParams } from "../session";
import type { AgentSessionStore } from "../store/session-store";
import { InMemorySessionStore } from "../store/session-store";
import type { AgentCheckpointRef } from "../store/checkpoint";
import { computeContextDigest } from "../store/checkpoint";
import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "../events";
import { createAgentRuntimeEvent } from "../events";
import { normalizeError } from "../errors";
import { createToolRegistry } from "../tool-registry";
import { runSessionIterations } from "./iteration";
import type { IterationOutcome, IterationStream } from "./iteration";
import { RuntimeHistory, assertCompleteHistory } from "./history";

export type AgentRuntimeState = "idle" | "running" | "interrupted" | "settled";

export interface AgentRuntimeConfig {
	readonly sessionId: string;
	readonly llmConfig: AgentLLMConfig;
	readonly expertRoleId: string;
	readonly sessionStore: AgentSessionStore;
	readonly tools: readonly AgentTool[];
	readonly maxIterations?: number;
	readonly initialMessages?: readonly AgentMessage[];
	readonly activeRoleId?: string;
	readonly identityPrompt?: string;
	readonly workRules?: string;
	readonly customLayers?: PromptLayer[];
	readonly locale?: "zh" | "en";
	readonly switchRoleToolDef?: ToolDefinition;
	readonly hooks?: {
		readonly buildDynamicContext?: () => string | null;
		readonly buildRagContext?: RagBuilder;
		readonly buildErrorRecovery?: ErrorRecoveryBuilder;
		readonly onRoleSwitch?: (roleId: string) => AgentLLMConfig | void;
	};
}

export interface AgentRuntime {
	readonly state: AgentRuntimeState;
	run(userMessage: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
	checkpoint(label?: string): Promise<AgentCheckpointRef>;
	abort(reason?: string): void;
}

type CompatibilitySession = { params: AgentSessionParams; config: AgentSessionConfig };

function createRuntime(config: AgentRuntimeConfig, compatibility?: CompatibilitySession): AgentRuntime {
	if (!compatibility && (!config.sessionId || !config.expertRoleId)) throw new TypeError("Runtime requires sessionId and expertRoleId");
	const maxIterations = config.maxIterations ?? 10;
	if (!compatibility && (!Number.isSafeInteger(maxIterations) || maxIterations < 0)) throw new TypeError("maxIterations must be a nonnegative safe integer");
	const history = new RuntimeHistory(config.sessionStore, config.sessionId);
	const registry = createToolRegistry();
	for (const tool of config.tools) {
		if (registry.get(tool.name)) throw new TypeError(`Duplicate runtime tool: ${tool.name}`);
		registry.register(tool);
	}
	let state: AgentRuntimeState = "idle";
	let active: AbortController | undefined;
	let llmConfig = config.llmConfig;
	let activeRoleId = config.activeRoleId ?? config.expertRoleId;

	async function executeToolCall(call: ToolCall) {
		const tool = registry.get(call.function.name);
		if (tool?.annotations?.requiresApproval || tool?.annotations?.destructive || tool?.requiresConfirmation) {
			return { success: false, message: "Tool requires approval; approval execution is not available in this runtime version" };
		}
		return registry.executeToolCall(call);
	}

	async function* run(userMessage: string, callerSignal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent> {
		if (active) throw new Error("An agent run is already active");
		if (typeof userMessage !== "string") throw new TypeError("User message must be a string");
		const controller = new AbortController();
		const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
		active = controller;
		state = "running";
		const runId = nanoid();
		const persistenceFailures = history.persistenceFailures;
		let seq = 0;
		let started = false;
		let terminal = false;
		let lastCheckpoint: AgentCheckpointRef | undefined;
		let iterator: IterationStream | undefined;
		const event = (payload: AgentRuntimeEventPayload): AgentRuntimeEvent => {
			const next = ++seq;
			if (compatibility) {
				// Internal bridge only: preserve the legacy callback value without strict v2 serialization.
				return { v: 2, runId, seq: next, ts: Date.now(), type: "kind" in payload ? payload.kind : payload.type, payload } as AgentRuntimeEvent;
			}
			return createAgentRuntimeEvent(runId, next, Date.now(), payload);
		};

		async function interrupt(): Promise<AgentRuntimeEvent> {
			lastCheckpoint = await history.checkpoint();
			await history.append({ kind: "run_interrupted", runId, cause: "interrupted", lastDurableBoundary: lastCheckpoint.checkpointId });
			terminal = true;
			state = "interrupted";
			return event({ kind: "run_interrupted", cause: "interrupted" });
		}

		try {
			const messages = compatibility ? [...compatibility.params.messages] : await history.load(config.initialMessages);
			if (!compatibility) assertCompleteHistory(messages);
			await history.append({ kind: "run_started", runId });
			started = true;
			if (!compatibility) {
				await history.append({ kind: "user_message", content: userMessage });
				messages.push({ id: nanoid(), role: "user", content: userMessage, createdAt: Date.now() });
			}
			yield event({ kind: "run_started", sessionId: config.sessionId });
			if (signal.aborted) { yield await interrupt(); return; }
			const params: AgentSessionParams = compatibility ? { ...compatibility.params, signal } : {
				messages, llmConfig, expertRoleId: config.expertRoleId, activeRoleId,
				identityPrompt: config.identityPrompt, workRules: config.workRules, customLayers: config.customLayers,
				locale: config.locale, switchRoleToolDef: config.switchRoleToolDef, tools: registry.getDefinitions(), signal,
			};
			const sessionConfig: AgentSessionConfig = compatibility?.config ?? {
				maxIterations, onToolCall: executeToolCall,
				onRoleSwitch(roleId) {
					activeRoleId = roleId;
					const updated = config.hooks?.onRoleSwitch?.(roleId);
					if (updated) llmConfig = updated;
					return updated;
				},
			};
			iterator = runSessionIterations(params, sessionConfig, {
				legacyToolResults: compatibility !== undefined,
				beforeIteration: compatibility ? undefined : failures => {
					const dynamicContext = config.hooks?.buildDynamicContext?.() ?? null;
					const rag = config.hooks?.buildRagContext?.(userMessage, {
						appState: dynamicContext ?? undefined, failedTools: failures.map(f => f.toolName),
					}) ?? "";
					const recovery = failures.length ? config.hooks?.buildErrorRecovery?.(failures) : undefined;
					return { dynamicContext, ragContext: recovery ? [rag, recovery].filter(Boolean).join("\n\n") : rag || null };
				},
				onMessage: async message => {
					if (compatibility && message.role === "tool") {
						const result = JSON.parse(message.content);
						// Private legacy store retains a summary; the kernel keeps the full original model history.
						await history.append({ kind: "tool_result", toolCallId: message.toolCallId!,
							result: { success: result.success, message: result.message } });
					} else await history.recordMessage(message);
				},
				onToolStart: async call => {
					const argsDigest = computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
					await history.append({ kind: "tool_call", toolCallId: call.id, name: call.function.name, argsDigest });
				},
			});
			let outcome: IterationOutcome;
			while (true) {
				const next = await iterator.next();
				if (next.done) { outcome = next.value; break; }
				const payload = next.value;
				if (signal.aborted) { yield await interrupt(); return; }
				if ("kind" in payload && payload.kind === "iteration_end") lastCheckpoint = await history.checkpoint();
				if ("type" in payload && payload.type === "message_end" && payload.usage) {
					await history.append({ kind: "usage", runId, usage: payload.usage });
				}
				yield event(payload);
			}
			if (signal.aborted || outcome.reason === "interrupted") { yield await interrupt(); return; }
			if (outcome.reason === "error") {
				const error = normalizeError(outcome.errorMessage ?? "Model request failed");
				await history.append({ kind: "run_failed", runId, error });
				terminal = true;
				state = "settled";
				yield event({ kind: "run_failed", error });
				return;
			}
			const reason = outcome.reason;
			await history.append({ kind: "run_completed", runId, reason, iterations: outcome.iterations });
			terminal = true;
			state = "settled";
			yield event({ kind: "run_completed", reason, iterations: outcome.iterations });
		} catch (cause) {
			if (history.persistenceFailures !== persistenceFailures) {
				terminal = true;
				state = "settled";
				if (started) {
					try { await history.append({ kind: "run_failed", runId, error: normalizeError(cause) }); }
					catch (recordFailure) { throw new AggregateError([cause, recordFailure], "Failed to persist run failure", { cause }); }
				}
				throw cause;
			}
			if (compatibility) throw cause;
			if (signal.aborted) { yield await interrupt(); return; }
			const error = normalizeError(cause);
			await history.append({ kind: "run_failed", runId, error });
			terminal = true;
			state = "settled";
			yield event({ kind: "run_failed", error });
		} finally {
			controller.abort();
			try {
				let cleanupFailure: unknown;
				let cleanupFailed = false;
				try { if (iterator) await iterator.return({ reason: "interrupted", iterations: 0 }); }
				catch (cause) { cleanupFailure = cause; cleanupFailed = true; }
				try { if (started && !terminal) await interrupt(); }
				catch (boundaryFailure) {
					if (cleanupFailed) throw new AggregateError([cleanupFailure, boundaryFailure], "Provider cleanup and interruption persistence failed");
					throw boundaryFailure;
				}
				if (cleanupFailed) throw cleanupFailure;
			} finally {
				active = undefined;
				if (!terminal) state = "interrupted";
			}
		}
	}

	return {
		get state() { return state; },
		run,
		checkpoint: label => history.checkpoint(label),
		abort(reason) { active?.abort(reason); },
	};
}

/** Run lifecycle and confirmed-message history; disk recovery is added in Phase 4. */
export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
	return createRuntime(config);
}

/** Internal bridge: the legacy session has no additional user input or public v2 events. */
export function createSessionRuntime(params: AgentSessionParams, config: AgentSessionConfig): AsyncGenerator<AgentRuntimeEvent> {
	const runtime = createRuntime({ sessionId: nanoid(), sessionStore: new InMemorySessionStore(),
		llmConfig: params.llmConfig, expertRoleId: params.expertRoleId, tools: [], maxIterations: config.maxIterations }, { params, config });
	return runtime.run("", params.signal);
}
