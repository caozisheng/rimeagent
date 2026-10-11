import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2, convertArrayToReadableStream } from "ai/test";
import { VercelAIBackend } from "../../src/adapters/vercel";
import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "../../src/types";

const config: AgentLLMConfig = { baseUrl: "https://example.test", apiKey: "test", model: "test" };
const tools: ToolDefinition[] = [{ type: "function", function: {
	name: "seek", description: "Seek", parameters: {
		type: "object", properties: { time: { type: "number" } }, required: ["time"],
	},
} }];
const finish: LanguageModelV2StreamPart = { type: "finish", finishReason: "stop",
	usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedInputTokens: 4 },
	providerMetadata: { test: { cost: 0.002, cacheWriteTokens: 2 } },
};
function modelWith(parts: LanguageModelV2StreamPart[]) {
	return new MockLanguageModelV2({ doStream: { stream: convertArrayToReadableStream(parts) } });
}
async function collect(backend: VercelAIBackend, messages: OpenAIMessage[] = [{ role: "user", content: "go" }], signal?: AbortSignal) {
	const chunks: StreamChunk[] = [];
	for await (const chunk of backend.streamChat(config, messages, signal, tools)) chunks.push(chunk);
	return chunks;
}

describe("Vercel transport", () => {
	test("preserves interleaved tool ids and emits complete calls only once", async () => {
		const model = modelWith([
			{ type: "tool-input-start", id: "a", toolName: "seek" },
			{ type: "tool-input-start", id: "b", toolName: "seek" },
			{ type: "tool-input-delta", id: "b", delta: '{"time":2}' },
			{ type: "tool-input-delta", id: "a", delta: '{"time":1}' },
			{ type: "tool-input-end", id: "a" }, { type: "tool-input-end", id: "b" },
			{ type: "tool-call", toolCallId: "b", toolName: "seek", input: '{"time":2}' },
			{ type: "tool-call", toolCallId: "a", toolName: "seek", input: '{"time":1}' },
			{ ...finish, finishReason: "tool-calls" },
		]);
		const chunks = await collect(new VercelAIBackend(() => model));
		expect(chunks.filter(c => c.type === "tool_calls_delta")).toEqual([
			{ type: "tool_calls_delta", index: 0, id: "a", functionName: "seek" },
			{ type: "tool_calls_delta", index: 1, id: "b", functionName: "seek" },
			{ type: "tool_calls_delta", index: 1, argumentsDelta: '{"time":2}' },
			{ type: "tool_calls_delta", index: 0, argumentsDelta: '{"time":1}' },
		]);
		expect(chunks.filter(c => c.type === "tool_calls_complete")).toEqual([{ type: "tool_calls_complete", toolCalls: [
			{ id: "a", type: "function", function: { name: "seek", arguments: '{"time":1}' } },
			{ id: "b", type: "function", function: { name: "seek", arguments: '{"time":2}' } },
		] }]);
		expect(model.doStreamCalls).toHaveLength(1);
	});

	test("maps streamed text and provider-reported cache and USD cost", async () => {
		const model = modelWith([{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "hello" }, { type: "text-end", id: "t" }, finish]);
		const chunks = await collect(new VercelAIBackend(() => model));
		expect(chunks).toEqual([{ type: "content_delta", delta: "hello" }, { type: "done", usage: {
			promptTokens: 12, completionTokens: 3, totalTokens: 15, cacheReadTokens: 4, cacheWriteTokens: 2, cost: 0.002,
		} }]);
	});

	test("historical tool results retain names and raw text rather than requiring JSON", async () => {
		const model = modelWith([finish]);
		await collect(new VercelAIBackend(() => model), [
			{ role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "seek", arguments: '{"time":2}' } }] },
			{ role: "tool", tool_call_id: "old", content: "Moved to 2s" },
			{ role: "user", content: "continue" },
		]);
		const toolMessage = model.doStreamCalls[0].prompt.find(m => m.role === "tool");
		expect(toolMessage).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "seek", output: { type: "text", value: "Moved to 2s" } }] });
	});

	test("rejects orphan tool results without issuing a model request", async () => {
		const model = modelWith([finish]);
		const chunks = await collect(new VercelAIBackend(() => model), [{ role: "tool", tool_call_id: "missing", content: "ok" }]);
		expect(chunks[0]?.type).toBe("error");
		if (chunks[0]?.type === "error") expect(chunks[0].error?.retryable).toBe(false);
		expect(model.doStreamCalls).toHaveLength(0);
	});

	test("provider 429 remains retryable but adapter performs no retries", async () => {
		const model = new MockLanguageModelV2({ doStream: async () => { throw new APICallError({
			message: "Too many requests", url: config.baseUrl, requestBodyValues: {}, statusCode: 429,
		}); } });
		const chunks = await collect(new VercelAIBackend(() => model));
		expect(chunks).toHaveLength(1);
		if (chunks[0].type !== "error") throw new Error("Expected provider error");
		expect(chunks[0].error?.category).toBe("provider");
		expect(chunks[0].error?.retryable).toBe(true);
		expect(model.doStreamCalls).toHaveLength(1);
	});

	test("malformed tool JSON is a failure, never an executable complete call", async () => {
		const model = modelWith([
			{ type: "tool-call", toolCallId: "bad", toolName: "seek", input: '{"time":' },
			{ ...finish, finishReason: "tool-calls" },
		]);
		const chunks = await collect(new VercelAIBackend(() => model));
		expect(chunks.some(c => c.type === "tool_calls_complete")).toBe(false);
		const error = chunks.find(c => c.type === "error");
		expect(error?.type === "error" && error.error?.category).toBe("tool_failure");
	});

	test("unfinished tool input cannot settle as a successful turn", async () => {
		const model = modelWith([
			{ type: "tool-input-start", id: "partial", toolName: "seek" },
			{ type: "tool-input-delta", id: "partial", delta: '{"time":' },
			{ ...finish, finishReason: "length" },
		]);
		const chunks = await collect(new VercelAIBackend(() => model));
		expect(chunks.some(c => c.type === "done" || c.type === "tool_calls_complete")).toBe(false);
		const error = chunks.find(c => c.type === "error");
		expect(error?.type === "error" && error.error?.category).toBe("tool_failure");
	});

	test("closing the consumer stream cancels the provider request", async () => {
		let providerSignal: AbortSignal | undefined;
		let close: () => void = () => {};
		const model = new MockLanguageModelV2({ doStream: async options => {
			providerSignal = options.abortSignal;
			return { stream: new ReadableStream<LanguageModelV2StreamPart>({ start(controller) {
				close = () => controller.close();
				controller.enqueue({ type: "text-start", id: "t" });
				controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
			} }) };
		} });
		const stream = new VercelAIBackend(() => model).streamChat(config, [{ role: "user", content: "go" }]);
		try {
			expect((await stream.next()).value).toEqual({ type: "content_delta", delta: "partial" });
			await stream.return(undefined);
			expect(providerSignal?.aborted).toBe(true);
		} finally { close(); }
	});

	test("pre-aborted request is interrupted without requesting provider", async () => {
		const model = modelWith([finish]);
		const controller = new AbortController();
		controller.abort();
		const chunks = await collect(new VercelAIBackend(() => model), undefined, controller.signal);
		if (chunks[0]?.type !== "error") throw new Error("Expected interrupted error");
		expect(chunks[0].error?.category).toBe("interrupted");
		expect(model.doStreamCalls).toHaveLength(0);
	});
});
