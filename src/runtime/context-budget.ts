import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { ContextBudget, ContextManagerConfig } from "./context-manager";

export function throwIfContextAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Operation was aborted", "AbortError");
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
}

export function validateContextConfig(config: ContextManagerConfig): void {
	if (config.tokenizer !== undefined && typeof config.tokenizer !== "function") throw new TypeError("Invalid tokenizer");
	if (config.contextTokens !== undefined) {
		positiveInteger(config.contextTokens, "contextTokens");
		if (config.contextTokens < 2) throw new TypeError("Context must leave room for input and output");
	}
	if (config.reserveOutputTokens !== undefined) positiveInteger(config.reserveOutputTokens, "reserveOutputTokens");
	if (config.maxToolResultTokens !== undefined) positiveInteger(config.maxToolResultTokens, "maxToolResultTokens");
	const ratio = config.compactTriggerRatio ?? 0.8;
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new TypeError("Invalid compactTriggerRatio");
	if (config.contextTokens !== undefined && config.reserveOutputTokens !== undefined && config.reserveOutputTokens >= config.contextTokens) {
		throw new TypeError("Output reserve must leave input tokens");
	}
}

export function contextBudget(config: ContextManagerConfig, llmConfig: AgentLLMConfig): ContextBudget {
	const contextTokens = config.contextTokens ?? llmConfig.contextLength ?? 32768;
	positiveInteger(contextTokens, "contextTokens");
	if (contextTokens < 2) throw new TypeError("Context must leave room for input and output");
	const reserveOutputTokens = config.reserveOutputTokens ?? Math.min(4096, Math.floor(contextTokens / 2));
	if (reserveOutputTokens >= contextTokens) throw new TypeError("Output reserve must leave input tokens");
	const inputTokens = contextTokens - reserveOutputTokens;
	return { contextTokens, reserveOutputTokens, inputTokens, triggerTokens: Math.floor(inputTokens * (config.compactTriggerRatio ?? 0.8)) };
}

export function createTokenCounter(config: ContextManagerConfig): (text: string) => number {
	const tokenizer = config.tokenizer ?? ((text: string) => Math.ceil(text.length / 4));
	return text => {
		const count = tokenizer(text);
		if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Tokenizer must return a finite nonnegative safe integer");
		return count;
	};
}

/** Count provider-visible fields only; persistence metadata cannot spend the model window. */
export function serializeContextRequest(systemPrompt: string, messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): string {
	const system = [systemPrompt, ...messages.filter(message => message.role === "system").map(message => message.content)].filter(Boolean).join("\n\n");
	return JSON.stringify({ messages: [{role:"system",content:system}, ...messages.filter(message => message.role !== "system").map(message => {
		if (message.role === "assistant" && message.toolCalls?.length) return {role:message.role,content:message.content || null,tool_calls:message.toolCalls};
		if (message.role === "tool") return {role:message.role,content:message.content,tool_call_id:message.toolCallId};
		return {role:message.role,content:message.content};
	})], tools });
}
