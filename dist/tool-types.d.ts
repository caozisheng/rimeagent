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
export interface AgentTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    requiresConfirmation?: boolean;
    execute: (args: Record<string, unknown>) => Promise<AgentToolResult>;
}
export declare function agentToolToDefinition(tool: AgentTool): ToolDefinition;
//# sourceMappingURL=tool-types.d.ts.map