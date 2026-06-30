import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
import { type LLMBackend } from "./llm-backend";
export declare class AnthropicLLMBackend implements LLMBackend {
    type: "anthropic";
    streamChat(config: AgentLLMConfig, messages: OpenAIMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
    private parseSSE;
}
//# sourceMappingURL=anthropic-backend.d.ts.map