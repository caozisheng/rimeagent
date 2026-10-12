import type { AgentMessage, ToolCall, TokenUsage } from "../types";
import type { AgentRuntimeEventPayload } from "../events";
import type { AgentSessionConfig, AgentSessionParams, ToolFailureRecord } from "../session";
import { nanoid } from "nanoid";
import { SWITCH_ROLE_TOOL_NAME } from "../service";
import type { PreparedAgentRequest, RunAgentLoopParams } from "../service";
import type { NormalizedError } from "../errors";
import { runIterationRequests } from "./request-attempt";

export interface IterationOutcome {
	reason: "response" | "max_iterations" | "error" | "interrupted";
	iterations: number;
	errorMessage?: string;
	error?: NormalizedError;
}
export type IterationStream = AsyncGenerator<AgentRuntimeEventPayload, IterationOutcome>;

export interface InitialIterationState {
	iterationOffset: number;
	pendingToolCalls?: readonly ToolCall[];
	failures?: readonly ToolFailureRecord[];
}
export interface IterationContext {
	dynamicContext?: string | null;
	ragContext?: string | null;
}
export interface IterationRequestInput {
	params: RunAgentLoopParams;
	iteration: number;
	attempt: number;
	failures: readonly ToolFailureRecord[];
}
export interface PreparedIterationRequest extends PreparedAgentRequest {
	events?: AgentRuntimeEventPayload[];
}
export interface IterationHooks {
	beforeIteration?: (failures: ToolFailureRecord[], iteration: number) => IterationContext | Promise<IterationContext>;
	beforeRequest?: (input: IterationRequestInput) => PreparedIterationRequest | Promise<PreparedIterationRequest>;
	onContextOverflow?: (error: NormalizedError, attempt: number) => boolean | Promise<boolean>;
	onPreparationError?: (cause: unknown) => void;
	onMessage?: (message: AgentMessage, usage?: TokenUsage) => Promise<void>;
	onToolStart?: (toolCall: ToolCall) => Promise<void>;
	initialState?: InitialIterationState;
	/** Internal compatibility policy: deliver callbacks before JSON history conversion. */
	legacyToolResults?: boolean;
}

/** The single iteration engine, including replay of an already confirmed tool batch. */
export async function* runSessionIterations(params: AgentSessionParams, config: AgentSessionConfig,
	hooks: IterationHooks = {}): IterationStream {
	let { llmConfig } = params;
	let activeRoleId = params.activeRoleId ?? params.expertRoleId;
	const allMessages = [...params.messages];
	let lastIterationFailures: ToolFailureRecord[] = [...(hooks.initialState?.failures ?? [])];
	let iterationOffset = hooks.initialState?.iterationOffset ?? 0;
	let iterations = iterationOffset;

	async function* executeBatch(calls: readonly ToolCall[]): AsyncGenerator<AgentRuntimeEventPayload, void> {
		const failures: ToolFailureRecord[] = [...lastIterationFailures];
		for (const call of calls) {
			if (params.signal?.aborted) return;
			await hooks.onToolStart?.(call);
			if (params.signal?.aborted) return;
			if (call.function.name === SWITCH_ROLE_TOOL_NAME) {
				let args: Record<string, unknown> = {};
				try { args = JSON.parse(call.function.arguments); } catch { /* Preserve legacy fallback. */ }
				activeRoleId = (args.role as string) ?? activeRoleId;
				const updated = config.onRoleSwitch?.(activeRoleId);
				if (updated) llmConfig = updated;
				const message: AgentMessage = { id: `tool-${nanoid()}`, role: "tool", toolCallId: call.id,
					content: JSON.stringify({ success: true, message: `Switched to ${activeRoleId}` }), createdAt: Date.now() };
				allMessages.push(message);
				await hooks.onMessage?.(message);
				if (params.signal?.aborted) return;
				yield { kind: "role_switch", roleId: activeRoleId };
				continue;
			}
			// A started callback finishes even when the caller cancels during execution.
			const result = await config.onToolCall(call);
			if (!result.success) failures.push({ toolName: call.function.name, errorMessage: result.message });
			if (hooks.legacyToolResults) yield { kind: "tool_result", toolCall: call, result };
			const message: AgentMessage = { id: `tool-${nanoid()}`, role: "tool", toolCallId: call.id,
				content: JSON.stringify(result), createdAt: Date.now() };
			allMessages.push(message);
			await hooks.onMessage?.(message);
			if (params.signal?.aborted) return;
			if (!hooks.legacyToolResults) yield { kind: "tool_result", toolCall: call, result };
		}
		lastIterationFailures = failures;
	}

	if (hooks.initialState?.pendingToolCalls?.length) {
		iterations = iterationOffset + 1;
		yield* executeBatch(hooks.initialState.pendingToolCalls);
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
		yield { kind: "iteration_end", iteration: iterationOffset };
		iterationOffset++;
	}
	for (let iteration = iterationOffset; iteration < config.maxIterations; iteration++) {
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
		iterations = iteration + 1;
		yield { kind: "iteration_start", iteration };
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
		const context = await hooks.beforeIteration?.(lastIterationFailures, iteration);
		const dynamicContext = context && "dynamicContext" in context ? context.dynamicContext : params.dynamicContext;
		let ragContext = context && "ragContext" in context ? context.ragContext : params.ragContext;
		if (lastIterationFailures.length && config.onIterationFailures) {
			const recovery = config.onIterationFailures(lastIterationFailures);
			if (recovery) ragContext = ragContext ? ragContext + "\n\n" + recovery : recovery;
		}
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
		const stream = runIterationRequests({
			params: { ...params, messages: allMessages, llmConfig, activeRoleId, dynamicContext, ragContext: ragContext ?? null },
			iteration, failures: lastIterationFailures,
		}, hooks);
		let pendingToolCalls: ToolCall[] = [];
		let assistantContent = "";
		for await (const event of stream) {
			if (params.signal?.aborted) return { reason: "interrupted", iterations };
			if ("kind" in event) {
				if (event.kind === "request_attempt_started") {
					pendingToolCalls = [];
					assistantContent = "";
				} else yield event;
				continue;
			}
			switch (event.type) {
				case "text_delta": assistantContent += event.content; yield event; break;
				case "tool_calls_complete": pendingToolCalls = event.toolCalls; yield event; break;
				case "message_end": {
					const message: AgentMessage = { id: `assistant-${nanoid()}`, role: "assistant", content: assistantContent,
						...(pendingToolCalls.length ? { toolCalls: pendingToolCalls } : {}), createdAt: Date.now() };
					allMessages.push(message);
					await hooks.onMessage?.(message, event.usage);
					yield event;
					if (params.signal?.aborted) return { reason: "interrupted", iterations };
					if (!pendingToolCalls.length) {
						yield { kind: "iteration_end", iteration };
						return { reason: params.signal?.aborted ? "interrupted" : "response", iterations };
					}
					lastIterationFailures = [];
					yield* executeBatch(pendingToolCalls);
					if (params.signal?.aborted) return { reason: "interrupted", iterations };
					assistantContent = "";
					pendingToolCalls = [];
					yield { kind: "iteration_end", iteration };
					break;
				}
				case "error":
					yield { type: "error", message: event.message };
					return { reason: params.signal?.aborted ? "interrupted" : "error", iterations, errorMessage: event.message,
						...("error" in event ? { error: event.error } : {}) };
				default: yield event; break;
			}
			if (params.signal?.aborted) return { reason: "interrupted", iterations };
		}
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
	}
	return { reason: params.signal?.aborted ? "interrupted" : "max_iterations", iterations };
}
