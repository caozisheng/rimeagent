import { afterEach, expect, test } from "bun:test";
import { MockLanguageModelV2, convertArrayToReadableStream } from "ai/test";
import { RimeAgentBackend } from "../../src/llm-backend";
import { streamAnthropicChat } from "../../src/anthropic-backend";
import { VercelAIBackend } from "../../src/adapters/vercel";
import type { AgentLLMConfig, OpenAIMessage, StreamChunk } from "../../src/types";
import { prepareAgentRequest, runPreparedAgentLoop } from "../../src/service";
import { registerLLMBackendFor } from "../../src/llm-client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const messages: OpenAIMessage[] = [{ role: "user", content: "go" }];
const config: AgentLLMConfig = { baseUrl: "https://api.example.test/v1", apiKey: "test", model: "test", directMode: true };
async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
	const result: StreamChunk[] = []; for await (const chunk of stream) result.push(chunk); return result;
}
function captureFetch(native: boolean): Record<string, unknown>[] {
	const bodies: Record<string, unknown>[] = [];
	globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(init?.body as string));
		return new Response(native ? 'event: message_stop\ndata: {}\n\n' : 'data: [DONE]\n\n');
	}, { preconnect: originalFetch.preconnect });
	return bodies;
}
for (const directMode of [true, false]) {
	test(`OpenAI ${directMode ? "direct" : "proxy"} request carries the actual output cap`, async () => {
		const bodies = captureFetch(false);
		await collect(new RimeAgentBackend().streamChat({ ...config, directMode, maxOutputTokens: 173 }, messages));
		expect(bodies[0][directMode ? "max_tokens" : "maxTokens"]).toBe(173);
		expect(bodies[0]).not.toHaveProperty(directMode ? "maxTokens" : "max_tokens");
	});
	test(`absent OpenAI ${directMode ? "direct" : "proxy"} cap preserves the old body`, async () => {
		const bodies = captureFetch(false);
		await collect(new RimeAgentBackend().streamChat({ ...config, directMode }, messages));
		expect(bodies[0]).toEqual(directMode ? { model: "test", messages, stream: true } : { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, messages });
	});
	test(`Anthropic ${directMode ? "direct" : "proxy"} request carries the output cap`, async () => {
		const bodies = captureFetch(true);
		await collect(new RimeAgentBackend().streamChat({ ...config, baseUrl: "https://api.anthropic.com", directMode, maxOutputTokens: 271 }, messages));
		expect(bodies[0].max_tokens).toBe(271);
	});
	test(`absent Anthropic ${directMode ? "direct" : "proxy"} cap preserves the previous default`, async () => {
		const bodies = captureFetch(true);
		await collect(new RimeAgentBackend().streamChat({ ...config, baseUrl: "https://api.anthropic.com", directMode }, messages));
		expect(bodies[0].max_tokens).toBe(8192);
		await collect(new RimeAgentBackend().streamChat({ ...config, baseUrl: "https://api.anthropic.com", directMode, contextLength: 1234 }, messages));
		expect(bodies[1].max_tokens).toBe(1234);
	});
}

test("Vercel SDK receives maxOutputTokens at its real model-call boundary", async () => {
	const model = new MockLanguageModelV2({ doStream: { stream: convertArrayToReadableStream([{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]) } });
	await collect(new VercelAIBackend(() => model).streamChat({ ...config, maxOutputTokens: 137 }, messages));
	expect(model.doStreamCalls[0].maxOutputTokens).toBe(137);
});

test("absent Vercel output cap does not impose a new SDK limit", async () => {
	const model = new MockLanguageModelV2({ doStream: { stream: convertArrayToReadableStream([{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]) } });
	await collect(new VercelAIBackend(() => model).streamChat(config, messages));
	expect(model.doStreamCalls[0].maxOutputTokens).toBeUndefined();
});

for (const cap of [0, -1, 1.5, NaN, Infinity]) {
	test(`invalid output cap ${cap} is rejected before every transport starts`, async () => {
		const bodies = captureFetch(false); let resolutions = 0;
		const model = new MockLanguageModelV2();
		const invalid = { ...config, maxOutputTokens: cap };
		await expect(collect(new RimeAgentBackend().streamChat(invalid, messages))).rejects.toThrow("maxOutputTokens");
		await expect(collect(streamAnthropicChat(invalid, messages, true))).rejects.toThrow("maxOutputTokens");
		await expect(collect(new VercelAIBackend(() => { resolutions++; return model; }).streamChat(invalid, messages))).rejects.toThrow("maxOutputTokens");
		expect(bodies).toEqual([]); expect(resolutions).toBe(0); expect(model.doStreamCalls).toHaveLength(0);
	});
}

test("actual HTTP error envelopes preserve code-only overflow while dropping opaque causes", async () => {
	globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ error: {
		code: "context_length_exceeded", message: "Rejected",
	} }), { status: 400 }), { preconnect: originalFetch.preconnect });
	const prepared = prepareAgentRequest({ llmConfig: config, expertRoleId: "general", messages: [
		{ id: "user", role: "user", content: "go", createdAt: 1 },
	] });
	const dispose = registerLLMBackendFor(candidate => candidate === config, new RimeAgentBackend());
	try {
		const events = []; for await (const event of runPreparedAgentLoop(prepared)) events.push(event);
		const failure = events.at(-1);
		if (failure?.type !== "error") throw new Error("Missing provider failure");
		expect(failure.error.category).toBe("context_overflow");
		expect(failure.error).not.toHaveProperty("cause");
	} finally { dispose(); }
});
