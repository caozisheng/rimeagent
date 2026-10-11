import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
/** Internal Anthropic transport used by RimeAgentBackend. */
export declare function streamAnthropicChat(config: AgentLLMConfig, messages: OpenAIMessage[], direct: boolean, signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=anthropic-backend.d.ts.map