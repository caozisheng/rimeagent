import type { AgentTool, AgentToolResult } from "./tool-types";
import { agentToolToDefinition } from "./tool-types";
import type { ToolDefinition, ToolCall } from "./types";

export interface ToolRegistryInstance {
	register(tool: AgentTool): void;
	get(name: string): AgentTool | undefined;
	getAll(): AgentTool[];
	getDefinitions(): ToolDefinition[];
	executeToolCall(toolCall: ToolCall): Promise<AgentToolResult>;
	clear(): void;
}

export function createToolRegistry(): ToolRegistryInstance {
	const tools = new Map<string, AgentTool>();

	return {
		register(tool: AgentTool): void {
			tools.set(tool.name, tool);
		},

		get(name: string): AgentTool | undefined {
			return tools.get(name);
		},

		getAll(): AgentTool[] {
			return Array.from(tools.values());
		},

		getDefinitions(): ToolDefinition[] {
			return Array.from(tools.values()).map(agentToolToDefinition);
		},

		async executeToolCall(toolCall: ToolCall): Promise<AgentToolResult> {
			const { name, arguments: argsStr } = toolCall.function;

			let args: Record<string, unknown>;
			try {
				args = JSON.parse(argsStr);
			} catch {
				return { success: false, message: "Invalid JSON arguments" };
			}

			const tool = tools.get(name);
			if (!tool) {
				return { success: false, message: `Unknown tool: ${name}` };
			}

			try {
				return await tool.execute(args);
			} catch (err) {
				return {
					success: false,
					message: err instanceof Error ? err.message : "Tool execution failed",
				};
			}
		},

		clear(): void {
			tools.clear();
		},
	};
}

export const ToolRegistry = createToolRegistry();
