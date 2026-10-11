import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
import type { LLMBackend } from "./llm-backend";
export { resolveProvider } from "./llm-backend";
export type LLMBackendPredicate = (config: AgentLLMConfig) => boolean;
export declare function registerLLMBackend(backend: LLMBackend): void;
/** Register a config-specific route; the newest matching registration wins. */
export declare function registerLLMBackendFor(predicate: LLMBackendPredicate, backend: LLMBackend): () => void;
export declare function getLLMBackend(config: AgentLLMConfig): LLMBackend;
export declare function streamChatCompletion(config: AgentLLMConfig, messages: OpenAIMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=llm-client.d.ts.map