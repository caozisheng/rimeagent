import type { AgentTool, AgentToolResult } from "./tool-types";
import type { ToolDefinition, ToolCall } from "./types";
export interface ToolRegistryInstance {
    register(tool: AgentTool): void;
    get(name: string): AgentTool | undefined;
    getAll(): AgentTool[];
    getDefinitions(): ToolDefinition[];
    executeToolCall(toolCall: ToolCall): Promise<AgentToolResult>;
    clear(): void;
}
export declare function createToolRegistry(): ToolRegistryInstance;
export declare const ToolRegistry: ToolRegistryInstance;
//# sourceMappingURL=tool-registry.d.ts.map