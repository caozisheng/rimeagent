import type {
	AgentEvent,
	AgentLLMConfig,
	AgentMessage,
	ToolCall,
	ToolDefinition,
} from "./types";
import type { AgentToolResult } from "./tool-types";
import type { PromptLayer } from "./prompt-builder";
import { runAgentLoop, SWITCH_ROLE_TOOL_NAME } from "./service";

export interface ToolFailureRecord {
	toolName: string;
	errorMessage: string;
}

export interface AgentSessionConfig {
	/** Maximum tool-call iterations before the session stops. */
	maxIterations: number;
	/** Execute a tool call and return the result. */
	onToolCall: (toolCall: ToolCall) => Promise<AgentToolResult>;
	/** Called when the LLM requests a role switch (orchestrator mode). Return updated llmConfig if the new role uses a different model. */
	onRoleSwitch?: (roleId: string) => AgentLLMConfig | void;
	/** Called with failures from the previous iteration, return optional recovery context to inject into ragContext. */
	onIterationFailures?: (failures: ToolFailureRecord[]) => string | undefined;
}

export interface AgentSessionParams {
	messages: AgentMessage[];
	llmConfig: AgentLLMConfig;
	expertRoleId: string;
	activeRoleId?: string;
	dynamicContext?: string | null;
	ragContext?: string | null;
	identityPrompt?: string;
	workRules?: string;
	tools?: ToolDefinition[];
	customLayers?: PromptLayer[];
	switchRoleToolDef?: ToolDefinition;
	locale?: "zh" | "en";
	signal?: AbortSignal;
}

export type AgentSessionEvent =
	| AgentEvent
	| { type: "tool_result"; toolCall: ToolCall; result: AgentToolResult }
	| { type: "role_switch"; roleId: string }
	| { type: "iteration_start"; iteration: number };

export async function* runAgentSession(
	params: AgentSessionParams,
	config: AgentSessionConfig,
): AsyncGenerator<AgentSessionEvent> {
	let { llmConfig } = params;
	let activeRoleId = params.activeRoleId ?? params.expertRoleId;
	let allMessages = [...params.messages];
	let lastIterationFailures: ToolFailureRecord[] = [];

	for (let iteration = 0; iteration < config.maxIterations; iteration++) {
		if (params.signal?.aborted) return;

		yield { type: "iteration_start", iteration };

		let ragContext = params.ragContext ?? undefined;
		if (lastIterationFailures.length > 0 && config.onIterationFailures) {
			const recovery = config.onIterationFailures(lastIterationFailures);
			if (recovery) {
				ragContext = ragContext ? ragContext + "\n\n" + recovery : recovery;
			}
		}

		const stream = runAgentLoop({
			...params,
			messages: allMessages,
			llmConfig,
			activeRoleId,
			ragContext: ragContext ?? null,
		});

		let pendingToolCalls: ToolCall[] = [];
		let assistantContent = "";

		for await (const event of stream) {
			if (params.signal?.aborted) return;

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
					yield event;

					if (pendingToolCalls.length === 0) return;

					const assistantMsg: AgentMessage = {
						id: `assistant-${Date.now()}-${iteration}`,
						role: "assistant",
						content: assistantContent,
						toolCalls: pendingToolCalls,
						createdAt: Date.now(),
					};
					allMessages = [...allMessages, assistantMsg];

					const failures: ToolFailureRecord[] = [];

					for (const tc of pendingToolCalls) {
						if (tc.function.name === SWITCH_ROLE_TOOL_NAME) {
							let args: Record<string, unknown> = {};
							try { args = JSON.parse(tc.function.arguments); } catch { /* skip */ }
							const newRoleId = (args.role as string) ?? activeRoleId;
							activeRoleId = newRoleId;

							if (config.onRoleSwitch) {
								const newConfig = config.onRoleSwitch(newRoleId);
								if (newConfig) llmConfig = newConfig;
							}

							yield { type: "role_switch", roleId: newRoleId };

							const toolMsg: AgentMessage = {
								id: `tool-${tc.id}`,
								role: "tool",
								content: JSON.stringify({ success: true, message: `Switched to ${newRoleId}` }),
								toolCallId: tc.id,
								createdAt: Date.now(),
							};
							allMessages = [...allMessages, toolMsg];
							continue;
						}

						const result = await config.onToolCall(tc);
						yield { type: "tool_result", toolCall: tc, result };

						if (!result.success) {
							failures.push({
								toolName: tc.function.name,
								errorMessage: result.message,
							});
						}

						const toolMsg: AgentMessage = {
							id: `tool-${tc.id}`,
							role: "tool",
							content: JSON.stringify(result),
							toolCallId: tc.id,
							createdAt: Date.now(),
						};
						allMessages = [...allMessages, toolMsg];
					}

					lastIterationFailures = failures;
					assistantContent = "";
					pendingToolCalls = [];
					break;
				}

				case "error":
					yield event;
					return;

				default:
					yield event;
					break;
			}
		}
	}
}
