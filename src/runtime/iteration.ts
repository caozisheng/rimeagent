import type { AgentMessage, ToolCall } from "../types";
import type { AgentRuntimeEventPayload } from "../events";
import type { AgentSessionConfig, AgentSessionParams, ToolFailureRecord } from "../session";
import { nanoid } from "nanoid";
import { runAgentLoop, SWITCH_ROLE_TOOL_NAME } from "../service";

export interface IterationOutcome {
	reason: "response" | "max_iterations" | "error" | "interrupted";
	iterations: number;
	errorMessage?: string;
}

export type IterationStream = AsyncGenerator<AgentRuntimeEventPayload, IterationOutcome>;

export interface IterationHooks {
	beforeIteration?: (failures: ToolFailureRecord[], iteration: number) => {
		dynamicContext?: string | null;
		ragContext?: string | null;
	};
	onMessage?: (message: AgentMessage) => Promise<void>;
	onToolStart?: (toolCall: ToolCall) => Promise<void>;
	/** Internal compatibility policy: deliver callback values before JSON history conversion. */
	legacyToolResults?: boolean;
}

/** The single iteration engine; its owner supplies persistence and lifecycle events. */
export async function* runSessionIterations(
	params: AgentSessionParams,
	config: AgentSessionConfig,
	hooks: IterationHooks = {},
): IterationStream {
	let { llmConfig } = params;
	let activeRoleId = params.activeRoleId ?? params.expertRoleId;
	const allMessages = [...params.messages];
	let lastIterationFailures: ToolFailureRecord[] = [];
	let iterations = 0;

	for (let iteration = 0; iteration < config.maxIterations; iteration++) {
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
		iterations++;
		yield { kind: "iteration_start", iteration };
		if (params.signal?.aborted) return { reason: "interrupted", iterations };

		const context = hooks.beforeIteration?.(lastIterationFailures, iteration);
		const dynamicContext = context && "dynamicContext" in context ? context.dynamicContext : params.dynamicContext;
		let ragContext = context && "ragContext" in context ? context.ragContext : params.ragContext;
		if (lastIterationFailures.length > 0 && config.onIterationFailures) {
			const recovery = config.onIterationFailures(lastIterationFailures);
			if (recovery) ragContext = ragContext ? ragContext + "\n\n" + recovery : recovery;
		}
		if (params.signal?.aborted) return { reason: "interrupted", iterations };

		const stream = runAgentLoop({
			...params,
			messages: allMessages,
			llmConfig,
			activeRoleId,
			dynamicContext,
			ragContext: ragContext ?? null,
		});
		let pendingToolCalls: ToolCall[] = [];
		let assistantContent = "";

		// Returning from this for-await closes runAgentLoop and its provider stream.
		for await (const event of stream) {
			if (params.signal?.aborted) return { reason: "interrupted", iterations };

			switch (event.type) {
				case "text_delta":
					assistantContent += event.content;
					yield event;
					break;
				case "tool_calls_complete":
					pendingToolCalls = event.toolCalls;
					yield event;
					break;
				case "message_end": {
					const assistantMsg: AgentMessage = {
						id: `assistant-${nanoid()}`,
						role: "assistant",
						content: assistantContent,
						...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),
						createdAt: Date.now(),
					};
					allMessages.push(assistantMsg);
					await hooks.onMessage?.(assistantMsg);
					yield event;
					if (params.signal?.aborted) return { reason: "interrupted", iterations };
					if (pendingToolCalls.length === 0) {
						yield { kind: "iteration_end", iteration };
						if (params.signal?.aborted) return { reason: "interrupted", iterations };
						return { reason: "response", iterations };
					}

					const failures: ToolFailureRecord[] = [];
					for (const tc of pendingToolCalls) {
						if (params.signal?.aborted) return { reason: "interrupted", iterations };
						await hooks.onToolStart?.(tc);
						if (params.signal?.aborted) return { reason: "interrupted", iterations };

						if (tc.function.name === SWITCH_ROLE_TOOL_NAME) {
							let args: Record<string, unknown> = {};
							try { args = JSON.parse(tc.function.arguments); } catch { /* keep legacy fallback */ }
							const newRoleId = (args.role as string) ?? activeRoleId;
							activeRoleId = newRoleId;
							if (config.onRoleSwitch) {
								const newConfig = config.onRoleSwitch(newRoleId);
								if (newConfig) llmConfig = newConfig;
							}
							const toolMsg: AgentMessage = {
								id: `tool-${nanoid()}`,
								role: "tool",
								content: JSON.stringify({ success: true, message: `Switched to ${newRoleId}` }),
								toolCallId: tc.id,
								createdAt: Date.now(),
							};
							allMessages.push(toolMsg);
							await hooks.onMessage?.(toolMsg);
							if (params.signal?.aborted) return { reason: "interrupted", iterations };
							yield { kind: "role_switch", roleId: newRoleId };
							continue;
						}

						// A started callback is allowed to finish even after cancellation.
						const result = await config.onToolCall(tc);
						if (!result.success) failures.push({ toolName: tc.function.name, errorMessage: result.message });
						if (hooks.legacyToolResults) yield { kind: "tool_result", toolCall: tc, result };
						const toolMsg: AgentMessage = {
							id: `tool-${nanoid()}`,
							role: "tool",
							content: JSON.stringify(result),
							toolCallId: tc.id,
							createdAt: Date.now(),
						};
						allMessages.push(toolMsg);
						await hooks.onMessage?.(toolMsg);
						if (params.signal?.aborted) return { reason: "interrupted", iterations };
						if (!hooks.legacyToolResults) yield { kind: "tool_result", toolCall: tc, result };
					}
					if (params.signal?.aborted) return { reason: "interrupted", iterations };
					lastIterationFailures = failures;
					assistantContent = "";
					pendingToolCalls = [];
					yield { kind: "iteration_end", iteration };
					break;
				}
				case "error":
					yield event;
					return { reason: params.signal?.aborted ? "interrupted" : "error", iterations, errorMessage: event.message };
				default:
					yield event;
					break;
			}
			if (params.signal?.aborted) return { reason: "interrupted", iterations };
		}
		if (params.signal?.aborted) return { reason: "interrupted", iterations };
	}
	return { reason: params.signal?.aborted ? "interrupted" : "max_iterations", iterations };
}
