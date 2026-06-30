import type { OpenAIMessage, ToolDefinition } from "./types";
export interface AnthropicContentBlock {
    type: "text" | "tool_use" | "tool_result";
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string;
}
export interface AnthropicMessage {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
}
export interface AnthropicTool {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}
export declare function convertTools(tools: ToolDefinition[]): AnthropicTool[];
export declare function convertMessages(messages: OpenAIMessage[]): {
    system: string | undefined;
    messages: AnthropicMessage[];
};
//# sourceMappingURL=anthropic-adapter.d.ts.map