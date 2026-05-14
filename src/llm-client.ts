import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
import { CloudLLMBackend, type LLMBackend } from "./llm-backend";
import { AnthropicLLMBackend } from "./anthropic-backend";

const openaiBackend = new CloudLLMBackend();
const anthropicBackend = new AnthropicLLMBackend();
let customBackend: LLMBackend | null = null;

export function registerLLMBackend(backend: LLMBackend): void {
	customBackend = backend;
}

export function resolveProvider(config: AgentLLMConfig): string {
	if (config.provider && config.provider !== "custom") return config.provider;
	const url = config.baseUrl.toLowerCase();
	if (url.includes("anthropic")) return "anthropic";
	if (url.includes("deepseek")) return "deepseek";
	return "openai";
}

export function getLLMBackend(config: AgentLLMConfig): LLMBackend {
	if (customBackend) return customBackend;
	const provider = resolveProvider(config);
	if (provider === "anthropic") return anthropicBackend;
	return openaiBackend;
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
