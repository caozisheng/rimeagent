import type { NormalizedError } from "./errors";

export type AgentStatus = "idle" | "thinking" | "streaming" | "error";

export type LLMProvider = "openai" | "anthropic" | "deepseek" | "local" | "custom";

export interface AgentLLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	provider?: LLMProvider;
	contextLength?: number;
	/** Effective request output cap; absent preserves the transport's default. */
	maxOutputTokens?: number;
	supportsToolCalls?: boolean;
	/** When true, bypass the proxy and call the LLM API directly from the client. */
	directMode?: boolean;
}

/** Legacy runAgentLoop/runAgentSession UI-only display shape; never durable metadata. */
export interface ToolResultSummary {
	name: string;
	success: boolean;
	message?: string;
	undoable: boolean;
}

export interface AgentMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	/** Legacy UI mirror only; durable session entries omit this field. */
	toolResults?: ToolResultSummary[];
	/** Legacy UI history only; agent checkpoints do not restore host state. */
	commandCheckpoint?: number;
	createdAt: number;
}

export interface TokenUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	/** Provider-reported cost in USD; absent when not supplied. */
	cost?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, unknown>;
			required?: string[];
		};
	};
}

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export type AgentEvent =
	| { type: "text_delta"; content: string }
	| { type: "tool_calls_complete"; toolCalls: ToolCall[] }
	| { type: "message_end"; usage?: TokenUsage }
	| { type: "error"; message: string }
	| { type: "status"; status: AgentStatus };

export type StreamChunk =
	| { type: "content_delta"; delta: string }
	| { type: "tool_calls_delta"; index: number; id?: string; functionName?: string; argumentsDelta?: string }
	| { type: "tool_calls_complete"; toolCalls: ToolCall[] }
	| { type: "done"; usage?: TokenUsage }
	| { type: "error"; message: string; error?: NormalizedError };

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}
