import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RimeAgentBackend, shouldUseDirect } from "../../src/llm-backend";
import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "../../src/types";

const originalFetch = globalThis.fetch;
let restoreConsoleError: (() => void) | undefined;
afterEach(() => {
	globalThis.fetch = originalFetch;
	restoreConsoleError?.();
	restoreConsoleError = undefined;
});

function replaceFetch(replacement: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
	globalThis.fetch = Object.assign(replacement, { preconnect: originalFetch.preconnect });
}

const backend = new RimeAgentBackend();
const config: AgentLLMConfig = {
	baseUrl: "https://api.example.com/v1/",
	apiKey: "test-key",
	model: "test-model",
	directMode: true,
};
const messages: OpenAIMessage[] = [
	{ role: "system", content: "Be helpful." },
	{ role: "user", content: "Hello" },
];
const tools: ToolDefinition[] = [{
	type: "function",
	function: { name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { key: { type: "string" } } } },
}];

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

function response(text: string): Response {
	return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

function openai(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

function anthropic(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("RimeAgentBackend protocol boundaries", () => {
	test("uses one baseline type and preserves explicit direct mode", () => {
		expect(backend.type).toBe("rimeagent");
		expect(shouldUseDirect({ ...config, directMode: true })).toBe(true);
		expect(shouldUseDirect({ ...config, directMode: false })).toBe(false);
	});

	const cases: Array<{ name: string; baseUrl: string; provider?: AgentLLMConfig["provider"]; native: boolean }> = [
		{ name: "inferred native Anthropic", baseUrl: "https://api.anthropic.com", native: true },
		{ name: "custom provider still infers native Anthropic", baseUrl: "https://api.anthropic.com", provider: "custom", native: true },
		{ name: "explicit native Anthropic", baseUrl: "https://api.anthropic.com/", provider: "anthropic", native: true },
		{ name: "explicit OpenAI overrides native host inference", baseUrl: "https://api.anthropic.com", provider: "openai", native: false },
		{ name: "explicit DeepSeek overrides native host inference", baseUrl: "https://api.anthropic.com", provider: "deepseek", native: false },
		{ name: "Anthropic third-party proxy", baseUrl: "https://proxy.example.com/v1/", provider: "anthropic", native: false },
		{ name: "Anthropic lookalike host", baseUrl: "https://api.anthropic.com.example.com", provider: "anthropic", native: false },
		{ name: "relative proxy URL", baseUrl: "/llm", provider: "anthropic", native: false },
		{ name: "inferred OpenAI", baseUrl: "https://api.example.com/v1/", native: false },
	];

	for (const entry of cases) {
		for (const directMode of [true, false]) {
			test(`${entry.name}, ${directMode ? "direct" : "proxy"}`, async () => {
				let requestUrl: unknown;
				let request: RequestInit | undefined;
				replaceFetch(async (url, init) => {
					requestUrl = url;
					request = init;
					return response(entry.native ? anthropic("message_stop", {}) : "data: [DONE]\n\n");
				});
				const current = { ...config, baseUrl: entry.baseUrl, provider: entry.provider, directMode };
				const signal = new AbortController().signal;
				expect(await collect(backend.streamChat(current, messages, signal, tools))).toEqual([{ type: "done" }]);
				expect(requestUrl).toBe(directMode
					? entry.baseUrl.replace(/\/+$/, "") + (entry.native ? "/v1/messages" : "/chat/completions")
					: "/api/ai/chat");
				expect(request?.method).toBe("POST");
				expect(request?.signal).toBe(signal);
				const headers = new Headers(request?.headers);
				expect(headers.get("Content-Type")).toBe("application/json");
				expect(headers.get("Authorization")).toBe(directMode && !entry.native ? "Bearer test-key" : null);
				expect(headers.get("x-api-key")).toBe(directMode && entry.native ? "test-key" : null);
				expect(headers.get("anthropic-version")).toBe(directMode && entry.native ? "2023-06-01" : null);
				expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe(directMode && entry.native ? "true" : null);
				const body = JSON.parse(request?.body as string);
				expect(body.model).toBe(current.model);
				expect(body.messages).toEqual(entry.native ? [{ role: "user", content: "Hello" }] : messages);
				expect(body.tools).toEqual(entry.native ? [{ name: "lookup", description: "Look up a value", input_schema: tools[0].function.parameters }] : tools);
				if (entry.native) {
					expect(body.system).toBe("Be helpful.");
					expect(body.max_tokens).toBe(8192);
					expect(body.stream).toBe(true);
					expect(body.tool_choice).toEqual({ type: "auto" });
				} else {
					expect(body.stream).toBe(directMode ? true : undefined);
					expect(body.tool_choice).toBe(directMode ? "auto" : undefined);
				}
				expect(body.provider).toBe(!directMode && entry.native ? "anthropic" : undefined);
				expect(body.baseUrl).toBe(directMode ? undefined : current.baseUrl);
				expect(body.apiKey).toBe(directMode ? undefined : current.apiKey);
			});
		}
	}
});

describe("baseline parser compatibility", () => {
	test("assembles OpenAI tool argument fragments and emits them once", async () => {
		replaceFetch(async () => response(
			openai({ choices: [{ delta: { content: "Looking up" } }] }) +
			"data: not-json\n\n" +
			openai({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: '{"key":' } }] } }] }) +
			openai({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] }, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n",
		));
		expect(await collect(backend.streamChat(config, messages))).toEqual([
			{ type: "content_delta", delta: "Looking up" },
			{ type: "tool_calls_complete", toolCalls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"key":"value"}' } }] },
			{ type: "done" },
		]);
	});

	test("assembles Anthropic tool argument fragments and preserves usage", async () => {
		replaceFetch(async () => response(
			anthropic("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Looking up" } }) +
			"event: content_block_delta\ndata: not-json\n\n" +
			anthropic("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-1", name: "lookup" } }) +
			anthropic("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"key":' } }) +
			anthropic("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '"value"}' } }) +
			anthropic("message_delta", { delta: { stop_reason: "tool_use" }, usage: { input_tokens: 4, output_tokens: 3 } }),
		));
		expect(await collect(backend.streamChat({ ...config, baseUrl: "https://api.anthropic.com" }, messages))).toEqual([
			{ type: "content_delta", delta: "Looking up" },
			{ type: "tool_calls_complete", toolCalls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"key":"value"}' } }] },
			{ type: "done", usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } },
		]);
	});

	test("preserves OpenAI terminal usage", async () => {
		replaceFetch(async () => response(openai({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })));
		expect(await collect(backend.streamChat(config, messages))).toEqual([{ type: "done", usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } }]);
	});
});

describe("baseline normalized errors", () => {
	for (const baseUrl of ["https://api.example.com/v1", "https://api.anthropic.com"]) {
		const current = { ...config, baseUrl };
		for (const entry of [
			{ error: new Error("connection reset by peer"), category: "provider" },
			{ error: new DOMException("stream aborted", "AbortError"), category: "interrupted" },
		]) {
			test(`${baseUrl} classifies ${entry.category} read failures without completing`, async () => {
				let first = true;
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (first) {
							first = false;
							const initial = baseUrl.includes("anthropic")
								? anthropic("content_block_delta", { delta: { type: "text_delta", text: "partial" } })
								: openai({ choices: [{ delta: { content: "partial" } }] });
							controller.enqueue(new TextEncoder().encode(initial));
						} else {
							controller.error(entry.error);
						}
					},
				}, { highWaterMark: 0 });
				replaceFetch(async () => new Response(body));
				const chunks = await collect(backend.streamChat(current, messages));
				expect(chunks).toHaveLength(2);
				expect(chunks[0]).toEqual({ type: "content_delta", delta: "partial" });
				expect(chunks[1]).toMatchObject({ type: "error", message: entry.error.message, error: { category: entry.category, message: entry.error.message, retryable: entry.category === "provider", cause: entry.error } });
				expect(body.locked).toBe(false);
			});
		}

		test(`${baseUrl} normalizes thrown fetch errors`, async () => {
			const error = new DOMException("request aborted", "AbortError");
			const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
			restoreConsoleError = () => { consoleErrorSpy.mockRestore(); };
			replaceFetch(async () => { throw error; });
			expect(await collect(backend.streamChat(current, messages))).toMatchObject([{ type: "error", message: error.message, error: { category: "interrupted", retryable: false, cause: error } }]);
		});

		test(`${baseUrl} preserves HTTP error message and classifies overflow`, async () => {
			replaceFetch(async () => new Response("maximum context length exceeded", { status: 400 }));
			expect(await collect(backend.streamChat(current, messages))).toMatchObject([{ type: "error", message: "API error 400: maximum context length exceeded", error: { category: "context_overflow", retryable: false } }]);
		});

		test(`${baseUrl} normalizes missing response bodies`, async () => {
			replaceFetch(async () => new Response(null));
			expect(await collect(backend.streamChat(current, messages))).toMatchObject([{ type: "error", message: "No response body", error: { category: "provider" } }]);
		});
	}

	test("normalizes Anthropic in-band error events", async () => {
		replaceFetch(async () => response(anthropic("error", { error: { type: "overloaded_error", message: "Overloaded" } })));
		expect(await collect(backend.streamChat({ ...config, baseUrl: "https://api.anthropic.com" }, messages))).toMatchObject([{ type: "error", message: "Overloaded", error: { category: "provider" } }]);
	});
});
