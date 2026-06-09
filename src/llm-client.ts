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
	try {
		const host = new URL(config.baseUrl).hostname;
		if (host === "api.anthropic.com") return "anthropic";
	} catch { /* fallback */ }
	return "openai";
}

function isNativeAnthropicHost(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

export function getLLMBackend(config: AgentLLMConfig): LLMBackend {
	if (customBackend) return customBackend;
	const provider = resolveProvider(config);
	// Only use native Anthropic backend for api.anthropic.com.
	// Third-party proxies expose OpenAI-compatible endpoints even for Claude models.
	if (provider === "anthropic" && isNativeAnthropicHost(config.baseUrl)) return anthropicBackend;
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
