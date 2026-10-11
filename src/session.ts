import type {
	AgentEvent,
	AgentLLMConfig,
	AgentMessage,
	ToolCall,
	ToolDefinition,
} from "./types";
import type { AgentToolResult } from "./tool-types";
import type { PromptLayer } from "./prompt-builder";
import { createSessionRuntime } from "./runtime/runtime";

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
	for await (const event of createSessionRuntime(params, config)) {
		const { payload } = event;
		if ("type" in payload) {
			switch (payload.type) {
				case "text_delta":
				case "tool_calls_complete":
				case "error":
				case "status":
					yield payload;
					break;
				case "message_end":
					yield { type: "message_end", usage: payload.usage };
					break;
			}
			continue;
		}
		switch (payload.kind) {
			case "iteration_start":
				yield { type: "iteration_start", iteration: payload.iteration };
				break;
			case "tool_result":
				yield { type: "tool_result", toolCall: payload.toolCall, result: payload.result };
				break;
			case "role_switch":
				yield { type: "role_switch", roleId: payload.roleId };
				break;
		}
	}
}
