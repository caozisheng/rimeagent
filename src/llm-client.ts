import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "./types";
import type { LLMBackend } from "./llm-backend";
import { RimeAgentBackend } from "./llm-backend";

export { resolveProvider } from "./llm-backend";

export type LLMBackendPredicate = (config: AgentLLMConfig) => boolean;

const baselineBackend = new RimeAgentBackend();
let customBackend: LLMBackend | null = null;
const registrations: Array<{
	predicate: LLMBackendPredicate;
	backend: LLMBackend;
}> = [];

export function registerLLMBackend(backend: LLMBackend): void {
	customBackend = backend;
}

/** Register a config-specific route; the newest matching registration wins. */
export function registerLLMBackendFor(
	predicate: LLMBackendPredicate,
	backend: LLMBackend,
): () => void {
	if (registrations.some((registration) => registration.predicate === predicate)) {
		throw new Error("LLM backend predicate is already registered");
	}
	const registration = { predicate, backend };
	registrations.push(registration);
	return () => {
		const index = registrations.indexOf(registration);
		if (index !== -1) registrations.splice(index, 1);
	};
}

export function getLLMBackend(config: AgentLLMConfig): LLMBackend {
	for (let index = registrations.length - 1; index >= 0; index--) {
		const registration = registrations[index];
		if (registration.predicate(config)) return registration.backend;
	}
	return customBackend ?? baselineBackend;
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
