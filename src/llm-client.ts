import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
import { CloudLLMBackend, type LLMBackend } from "./llm-backend";

const defaultBackend = new CloudLLMBackend();
let customBackend: LLMBackend | null = null;

export function registerLLMBackend(backend: LLMBackend): void {
	customBackend = backend;
}

export function getLLMBackend(_config: AgentLLMConfig): LLMBackend {
	return customBackend ?? defaultBackend;
}

export function streamChatCompletion(
	config: AgentLLMConfig,
	messages: OpenAIMessage[],
	signal?: AbortSignal,
	tools?: ToolDefinition[],
): AsyncGenerator<StreamChunk> {
	const backend = getLLMBackend(config);
	return backend.streamChat(config, messages, signal, tools);
}
