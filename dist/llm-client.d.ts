import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
import { type LLMBackend } from "./llm-backend";
export declare function registerLLMBackend(backend: LLMBackend): void;
export declare function resolveProvider(config: AgentLLMConfig): string;
export declare function getLLMBackend(config: AgentLLMConfig): LLMBackend;
export declare function streamChatCompletion(config: AgentLLMConfig, messages: OpenAIMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=llm-client.d.ts.map