import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
export interface LLMBackend {
    type: string;
    streamChat(config: AgentLLMConfig, messages: OpenAIMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
}
export declare function shouldUseDirect(config: AgentLLMConfig): boolean;
export declare class CloudLLMBackend implements LLMBackend {
    type: "cloud";
    streamChat(config: AgentLLMConfig, messages: OpenAIMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
}
//# sourceMappingURL=llm-backend.d.ts.map