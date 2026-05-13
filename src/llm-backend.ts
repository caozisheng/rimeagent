import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolCall, ToolDefinition } from "./types";

export interface LLMBackend {
	type: string;
	streamChat(
		config: AgentLLMConfig,
		messages: OpenAIMessage[],
		signal?: AbortSignal,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamChunk>;
}

export class CloudLLMBackend implements LLMBackend {
	type = "cloud" as const;

	private shouldUseDirect(): boolean {
		if (typeof window === "undefined") return false;
		return !!(window as unknown as Record<string, unknown>).__TAURI__ ||
			navigator.userAgent.includes("wv") ||
			typeof (window as unknown as Record<string, unknown>).__CAPACITOR__ !== "undefined";
	}

	async *streamChat(
		config: AgentLLMConfig,
		messages: OpenAIMessage[],
		signal?: AbortSignal,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamChunk> {
		const direct = this.shouldUseDirect();
		const url = direct
			? config.baseUrl.replace(/\/+$/, "") + "/chat/completions"
			: "/api/ai/chat";

		let response: Response;
		try {
			const body: Record<string, unknown> = direct
				? { model: config.model, messages, stream: true }
				: { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, messages };
			if (tools && tools.length > 0) {
				body.tools = tools;
				if (direct) body.tool_choice = "auto";
			}
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (direct) {
				headers.Authorization = `Bearer ${config.apiKey}`;
			}
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Network error";
			console.error("[LLM] fetch failed:", msg);
			yield { type: "error", message: msg };
			return;
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "Unknown error");
			yield { type: "error", message: `API error ${response.status}: ${text}` };
			return;
		}

		const responseBody = response.body;
		if (!responseBody) {
			yield { type: "error", message: "No response body" };
			return;
		}

		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const pendingToolCalls = new Map<number, ToolCall>();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const text = decoder.decode(value, { stream: true });
				buffer += text;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(":")) continue;
					if (!trimmed.startsWith("data: ")) continue;
					const data = trimmed.slice(6);

					if (data === "[DONE]") {
						if (pendingToolCalls.size > 0) {
							yield {
								type: "tool_calls_complete",
								toolCalls: Array.from(pendingToolCalls.values()),
							};
							pendingToolCalls.clear();
						}
						yield { type: "done" };
						return;
					}

					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta;

						if (delta?.content) {
							yield { type: "content_delta", delta: delta.content };
						}

						if (delta?.tool_calls) {
							for (const tc of delta.tool_calls as Array<{
								index: number;
								id?: string;
								type?: string;
								function?: { name?: string; arguments?: string };
							}>) {
								const idx = tc.index;
								if (!pendingToolCalls.has(idx)) {
									pendingToolCalls.set(idx, {
										id: tc.id ?? "",
										type: "function",
										function: {
											name: tc.function?.name ?? "",
											arguments: tc.function?.arguments ?? "",
										},
									});
								} else {
									const existing = pendingToolCalls.get(idx)!;
									if (tc.id) existing.id = tc.id;
									if (tc.function?.name) existing.function.name = tc.function.name;
									if (tc.function?.arguments) {
										existing.function.arguments += tc.function.arguments;
									}
								}
							}
						}

						const finishReason = parsed.choices?.[0]?.finish_reason;
						if (finishReason === "tool_calls") {
							if (pendingToolCalls.size > 0) {
								yield {
									type: "tool_calls_complete",
									toolCalls: Array.from(pendingToolCalls.values()),
								};
								pendingToolCalls.clear();
							}
							yield { type: "done" };
							return;
						}
						if (finishReason === "stop") {
							const usage = parsed.usage;
							yield {
								type: "done",
								usage: usage
									? {
											promptTokens: usage.prompt_tokens,
											completionTokens: usage.completion_tokens,
											totalTokens: usage.total_tokens,
										}
									: undefined,
							};
							return;
						}
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}

			if (pendingToolCalls.size > 0) {
				yield {
					type: "tool_calls_complete",
					toolCalls: Array.from(pendingToolCalls.values()),
				};
			}
			yield { type: "done" };
		} finally {
			reader.releaseLock();
		}
	}
}
