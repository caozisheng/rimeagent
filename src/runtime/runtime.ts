import { nanoid } from "nanoid";
import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { AgentTool } from "../tool-types";
import type { PromptLayer } from "../prompt-builder";
import type { RagBuilder, ErrorRecoveryBuilder } from "../rag-types";
import type { AgentSessionConfig, AgentSessionParams } from "../session";
import type { AgentSessionStore } from "../store/session-store";
import { InMemorySessionStore } from "../store/session-store";
import type { AgentCheckpointRef } from "../store/checkpoint";
import { computeContextDigest } from "../store/checkpoint";
import type { AgentArtifactStore } from "../store/artifact-store";
import { InMemoryArtifactStore } from "../store/artifact-store";
import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "../events";
import { createAgentRuntimeEvent } from "../events";
import { normalizeError } from "../errors";
import type { AgentErrorCategory } from "../errors";
import { createToolRegistry } from "../tool-registry";
import { runSessionIterations } from "./iteration";
import type { IterationOutcome, IterationStream } from "./iteration";
import { RuntimeHistory, assertCompleteHistory, projectMessages } from "./history";
import { assertNewRun, loadResumeState, rejectRecovery } from "./recovery";
import type { ResumeState } from "./recovery";
import type { ContextManagerConfig, ContextSummarizer, ProjectFactsDigest } from "./context-manager";
import type { ToolFailureRecord } from "../session";
import { createRuntimeRequestContext } from "./request-context";
import type { LedgerRecord, RuntimeLedger } from "./ledger";
import { InMemoryLedger } from "./ledger";
import { createToolExecutor } from "./executor";

export type AgentRuntimeState = "idle" | "running" | "interrupted" | "settled";
export interface AgentRuntimeConfig {
	readonly sessionId: string;
	readonly llmConfig: AgentLLMConfig;
	readonly expertRoleId: string;
	readonly sessionStore: AgentSessionStore;
	readonly ledger?: RuntimeLedger;
	readonly artifactStore?: AgentArtifactStore;
	readonly tools: readonly AgentTool[];
	readonly maxIterations?: number;
	readonly context?: ContextManagerConfig;
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
		readonly getProjectFacts?: () => ProjectFactsDigest;
		readonly summarizeContext?: ContextSummarizer;
		/** Host returns tool names from active skills' toolRefs; definitions stay engine-owned. */
		readonly filterTools?: (tools: readonly ToolDefinition[], context: {
			activeRoleId: string; projectFacts?: ProjectFactsDigest; failures: readonly ToolFailureRecord[];
		}) => readonly string[] | Promise<readonly string[]>;
	};
}
export interface AgentRuntime {
	readonly state: AgentRuntimeState;
	run(userMessage: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
	resume(runId: string, signal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent>;
	checkpoint(label?: string): Promise<AgentCheckpointRef>;
	abort(reason?: string): void;
}
type CompatibilitySession = { params: AgentSessionParams; config: AgentSessionConfig };

function createRuntime(config: AgentRuntimeConfig, compatibility?: CompatibilitySession): AgentRuntime {
	if (!compatibility && (!config.sessionId || !config.expertRoleId)) throw new TypeError("Runtime requires sessionId and expertRoleId");
	const maxIterations = config.maxIterations ?? 10;
	if (!compatibility && (!Number.isSafeInteger(maxIterations) || maxIterations < 0)) throw new TypeError("maxIterations must be a nonnegative safe integer");
	const history = new RuntimeHistory(config.sessionStore, config.sessionId);
	const ledger = config.ledger ?? new InMemoryLedger();
	const artifactStore = config.artifactStore ?? new InMemoryArtifactStore();
	const executor = createToolExecutor({ sessionId: config.sessionId, tools: config.tools, ledger, artifactStore });
	const registry = createToolRegistry();
	for (const tool of config.tools) {
		if (registry.get(tool.name)) throw new TypeError(`Duplicate runtime tool: ${tool.name}`);
		registry.register(tool);
	}
	let state: AgentRuntimeState = "idle";
	let active: AbortController | undefined;
	let llmConfig = config.llmConfig;
	let activeRoleId = config.activeRoleId ?? config.expertRoleId;
	let activeCheckpoint: ((label?: string) => Promise<AgentCheckpointRef>) | undefined;

	async function* execute(userInput: string | undefined, resumeId: string | undefined,
		callerSignal?: AbortSignal): AsyncGenerator<AgentRuntimeEvent> {
		if (active) throw new Error("An agent run is already active");
		if (resumeId === undefined && typeof userInput !== "string") throw new TypeError("User message must be a string");
		const controller = new AbortController();
		const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
		active = controller;
		const previousState = state;
		const runId = resumeId ?? nanoid();
		const persistenceFailures = history.persistenceFailures;
		let ledgerFailed = false;
		let seq = 0;
		let iteration = 0;
		let phase: "model" | "tools" | "settled" = "model";
		let started = false;
		let validated = false;
		let terminal = false;
		let lastCheckpoint: AgentCheckpointRef | undefined;
		let iterator: IterationStream | undefined;
		const nextSeq = () => ++seq;
		// Message hooks can settle the phase while the iteration generator is suspended.
		const hasSettledResponse = (): boolean => phase === "settled";

		async function recordLedger(event: LedgerRecord["event"]): Promise<void> {
			if (compatibility) return;
			try { await ledger.append({ runId, seq: nextSeq(), ts: Date.now(), event }); }
			catch (cause) { ledgerFailed = true; throw cause; }
		}
		async function saveCursor(): Promise<void> {
			if (compatibility) return;
			await history.append({ kind: "run_state", runId, seq, iteration, phase, activeRoleId,
				...(lastCheckpoint === undefined ? {} : { checkpointId: lastCheckpoint.checkpointId }) });
		}
		async function boundary(label?: string): Promise<AgentCheckpointRef> {
			const facts = config.hooks?.getProjectFacts?.();
			lastCheckpoint = await history.checkpoint(label, compatibility ? undefined : {
				runId, seq: nextSeq(), ...(facts === undefined ? {} : { projectFacts: facts }) });
			return lastCheckpoint;
		}
		async function assertProjectBoundary(): Promise<void> {
			if (!lastCheckpoint || compatibility) return;
			const facts = config.hooks?.getProjectFacts?.();
			if (lastCheckpoint.projectRevision !== undefined && facts?.projectRevision !== lastCheckpoint.projectRevision) rejectRecovery("Project revision changed before external execution");
			if (lastCheckpoint.projectId !== undefined && facts?.projectId !== lastCheckpoint.projectId) rejectRecovery("Project identity changed before external execution");
		}
		async function assertHostBoundary(): Promise<void> {
			if (!lastCheckpoint || compatibility) return;
			await assertProjectBoundary();
			if (computeContextDigest(projectMessages(await history.entries())) !== lastCheckpoint.contextDigest) rejectRecovery("Context digest changed before external execution");
		}
		async function event(payload: AgentRuntimeEventPayload): Promise<AgentRuntimeEvent> {
			const next = nextSeq();
			if (compatibility) return { v: 2, runId, seq: next, ts: Date.now(),
				type: "kind" in payload ? payload.kind : payload.type, payload } as AgentRuntimeEvent;
			const result = createAgentRuntimeEvent(runId, next, Date.now(), payload);
			await saveCursor();
			return result;
		}
		async function interrupt(cause: AgentErrorCategory = "interrupted"): Promise<AgentRuntimeEvent> {
			// Do not adopt unrelated host changes while settling an interruption.
			if (!lastCheckpoint || compatibility) await boundary();
			await history.append({ kind: "run_interrupted", runId, cause, lastDurableBoundary: lastCheckpoint!.checkpointId });
			await recordLedger({ kind: "terminal", status: "interrupted" });
			const result = await event({ kind: "run_interrupted", cause });
			terminal = true;
			state = "interrupted";
			return result;
		}

		try {
			let restored: ResumeState | undefined;
			let messages: AgentMessage[];
			if (resumeId !== undefined) {
				restored = await loadResumeState(history, ledger, resumeId, config.hooks?.getProjectFacts?.(), artifactStore);
				messages = restored.messages;
				seq = restored.seq;
				iteration = restored.iteration;
				phase = restored.phase;
				activeRoleId = restored.activeRoleId;
				lastCheckpoint = restored.checkpoint;
				llmConfig = config.hooks?.onRoleSwitch?.(activeRoleId) || config.llmConfig;
			} else {
				if (!compatibility) assertNewRun(await history.entries());
				if (!compatibility && config.initialMessages) assertCompleteHistory(config.initialMessages);
				messages = compatibility ? [...compatibility.params.messages] : await history.load(config.initialMessages);
				if (!compatibility) {
					assertCompleteHistory(messages);
					activeRoleId = config.activeRoleId ?? config.expertRoleId;
					llmConfig = config.llmConfig;
				}
			}
			validated = true;
			state = "running";
			activeCheckpoint = boundary;
			const userMessage = restored?.userMessage ?? userInput!;
			if (!restored) {
				await history.append({ kind: "run_started", runId });
				started = true;
				if (!compatibility) {
					await history.append({ kind: "user_message", content: userMessage });
					messages.push({ id: nanoid(), role: "user", content: userMessage, createdAt: Date.now() });
				}
			} else started = true;
			await boundary();
			yield await event({ kind: restored ? "run_resumed" : "run_started", sessionId: config.sessionId });
			if (signal.aborted) { yield await interrupt(); return; }
			const params: AgentSessionParams = compatibility ? { ...compatibility.params, signal } : {
				messages, llmConfig, expertRoleId: config.expertRoleId, activeRoleId,
				identityPrompt: config.identityPrompt, workRules: config.workRules, customLayers: config.customLayers,
				locale: config.locale, switchRoleToolDef: config.switchRoleToolDef, tools: registry.getDefinitions(), signal,
			};
			const sessionConfig: AgentSessionConfig = compatibility?.config ?? {
				maxIterations,
				async onToolCall(call) {
					try { return await executor.execute(call, { runId, nextSeq, signal }); }
					catch (cause) {
						// Executor persistence errors must remain rejected, not a false completion.
						if (!(typeof cause === "object" && cause !== null && "category" in cause)) ledgerFailed = true;
						throw cause;
					}
				},
				onRoleSwitch(roleId) {
					activeRoleId = roleId;
					const updated = config.hooks?.onRoleSwitch?.(roleId);
					if (updated) llmConfig = updated;
					return updated;
				},
			};
			const requestContext = compatibility ? undefined : createRuntimeRequestContext({config, artifactStore, signal,
				assertBoundary: assertHostBoundary, recordLedger, onPersistenceFailure: () => { ledgerFailed = true; },
				hasPersistenceFailure: () => ledgerFailed || history.persistenceFailures !== persistenceFailures});
			let outcome: IterationOutcome;
			if (hasSettledResponse()) outcome = { reason: "response", iterations: iteration + 1 };
			else {
				iterator = runSessionIterations(params, sessionConfig, {
					legacyToolResults: compatibility !== undefined,
					initialState: restored ? { iterationOffset: iteration, pendingToolCalls: restored.pendingToolCalls, failures: restored.failures } : undefined,
					beforeRequest: requestContext?.prepare,
					onContextOverflow: requestContext?.recover,
					onPreparationError: requestContext?.guardPreparationError,
					onMessage: async (message, usage) => {
						if (!compatibility && message.role === "assistant") {
							await recordLedger({ kind: "model_call", provider: llmConfig.provider ?? "openai", model: llmConfig.model,
								requestIndex: iteration, usage: usage ?? {} });
							if (usage) await history.append({ kind: "usage", runId, usage });
							await assertHostBoundary();
						}
						if (compatibility && message.role === "tool") {
							const result = JSON.parse(message.content);
							await history.append({ kind: "tool_result", toolCallId: message.toolCallId!, result: { success: result.success, message: result.message } });
						} else {
							let artifactId: string | undefined;
							if (message.role === "tool" && message.toolCallId) {
								try {
									const execution = await ledger.getToolExecution(message.toolCallId);
									if (execution?.event.kind === "tool_exec") artifactId = execution.event.artifactId;
								} catch (cause) { ledgerFailed = true; throw cause; }
							}
							await history.recordMessage(message, artifactId);
						}
						if (!compatibility) {
							if (message.role === "assistant") phase = message.toolCalls?.length ? "tools" : "settled";
							if (message.role === "assistant") await assertProjectBoundary();
							await boundary();
							await saveCursor();
						}
					},
					onToolStart: async call => {
						await assertHostBoundary();
						await boundary();
						const argsDigest = computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
						await history.append({ kind: "tool_call", toolCallId: call.id, name: call.function.name, argsDigest });
					},
				});
				while (true) {
					const next = await iterator.next();
					if (next.done) { outcome = next.value; break; }
					const payload = next.value;
					if (signal.aborted) { yield await interrupt(); return; }
					if ("kind" in payload && payload.kind === "iteration_start") {
						await assertHostBoundary();
						iteration = payload.iteration;
						phase = "model";
						await boundary();
					}
					if ("kind" in payload && payload.kind === "iteration_end") {
						if (phase !== "settled") { phase = "model"; iteration = payload.iteration + 1; }
						await boundary();
					}
					yield await event(payload);
				}
			}
			if (signal.aborted || outcome.reason === "interrupted") { yield await interrupt(); return; }
			if (outcome.reason === "error") {
				const error = outcome.error ?? normalizeError(outcome.errorMessage ?? "Model request failed");
				if (error.category === "context_overflow") {
					await history.append({ kind: "error", error });
					yield await interrupt("context_overflow");
					return;
				}
				await recordLedger({ kind: "terminal", status: "failed" });
				await history.append({ kind: "run_failed", runId, error });
				phase = "settled";
				const result = await event({ kind: "run_failed", error });
				terminal = true; state = "settled";
				yield result;
				return;
			}
			phase = "settled";
			const result = await event({ kind: "run_completed", reason: outcome.reason, iterations: outcome.iterations });
			await recordLedger({ kind: "terminal", status: "completed" });
			await history.append({ kind: "run_completed", runId, reason: outcome.reason, iterations: outcome.iterations });
			terminal = true; state = "settled";
			yield result;
		} catch (cause) {
			if (!validated) { state = previousState; throw cause; }
			if (history.persistenceFailures !== persistenceFailures || ledgerFailed) {
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
			if (error.category === "context_overflow") {
				await history.append({ kind: "error", error });
				yield await event({ type: "error", message: error.message });
				yield await interrupt("context_overflow");
				return;
			}
			await recordLedger({ kind: "terminal", status: "failed" });
			await history.append({ kind: "run_failed", runId, error });
			phase = "settled";
			const result = await event({ kind: "run_failed", error });
			terminal = true; state = "settled";
			yield result;
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
				activeCheckpoint = undefined;
				if (validated && !terminal) state = "interrupted";
			}
		}
	}
	return {
		get state() { return state; },
		run: (message, signal) => execute(message, undefined, signal),
		resume: (runId, signal) => execute(undefined, runId, signal),
		checkpoint: label => activeCheckpoint ? activeCheckpoint(label) : history.checkpoint(label),
		abort(reason) { active?.abort(reason); },
	};
}

/** Durable run lifecycle and confirmed-message history. */
export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
	return createRuntime(config);
}
/** Internal bridge: legacy sessions add no user input and expose their original callback values. */
export function createSessionRuntime(params: AgentSessionParams, config: AgentSessionConfig): AsyncGenerator<AgentRuntimeEvent> {
	const runtime = createRuntime({ sessionId: nanoid(), sessionStore: new InMemorySessionStore(),
		llmConfig: params.llmConfig, expertRoleId: params.expertRoleId, tools: [], maxIterations: config.maxIterations }, { params, config });
	return runtime.run("", params.signal);
}
