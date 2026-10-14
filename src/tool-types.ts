import type { ToolDefinition } from "./types";

export interface ToolSuggestion {
	type: "similar_id" | "similar_name" | "similar_file" | "syntax_hint" | "alternative";
	text: string;
}

export interface AgentToolResult {
	success: boolean;
	message: string;
	data?: Record<string, unknown>;
	undoable?: boolean;
	suggestions?: ToolSuggestion[];
}
/** Evidence from the host's committed operation, never inferred from result.data. */
export interface ExternalStateBinding { readonly scopeId: string; readonly version: string }
export interface ExecutionReceipt {
	readonly operationId?: string;
	readonly stateChange?: { readonly before: ExternalStateBinding; readonly after: ExternalStateBinding };
}
export interface DurableToolExecution { readonly result: Omit<AgentToolResult, "undoable">; readonly receipt?: ExecutionReceipt }


export interface AgentToolAnnotations {
	readonly readOnly?: boolean;
	readonly destructive?: boolean;
	readonly idempotent?: boolean;
	readonly requiresApproval?: boolean;
	readonly executionMode?: "serial" | "parallel";
}

export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	requiresConfirmation?: boolean;
	annotations?: AgentToolAnnotations;
	execute: (args: Record<string, unknown>) => Promise<AgentToolResult>;
}
export type DurableAgentTool = Omit<AgentTool, "execute"> & {
	execute: (args: Record<string, unknown>) => Promise<DurableToolExecution>;
};

export function agentToolToDefinition(tool: Omit<AgentTool, "execute">): ToolDefinition {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as ToolDefinition["function"]["parameters"],
		},
	};
}
