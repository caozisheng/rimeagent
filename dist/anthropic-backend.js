import { shouldUseDirect } from "./llm-backend";
import { convertTools, convertMessages } from "./anthropic-adapter";
export class AnthropicLLMBackend {
    type = "anthropic";
    async *streamChat(config, messages, signal, tools) {
        const direct = shouldUseDirect(config);
        const { system, messages: anthropicMessages } = convertMessages(messages);
        const apiBody = {
            model: config.model,
            max_tokens: config.contextLength ?? 8192,
            stream: true,
            messages: anthropicMessages,
        };
        if (system)
            apiBody.system = system;
        if (tools?.length) {
            apiBody.tools = convertTools(tools);
            apiBody.tool_choice = { type: "auto" };
        }
        let response;
        try {
            if (direct) {
                const url = config.baseUrl.replace(/\/+$/, "") + "/v1/messages";
                response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": config.apiKey,
                        "anthropic-version": "2023-06-01",
                        "anthropic-dangerous-direct-browser-access": "true",
                    },
                    body: JSON.stringify(apiBody),
                    signal,
                });
            }
            else {
                response = await fetch("/api/ai/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        provider: "anthropic",
                        baseUrl: config.baseUrl,
                        apiKey: config.apiKey,
                        ...apiBody,
                    }),
                    signal,
                });
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : "Network error";
            yield { type: "error", message: msg };
            return;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "Unknown error");
            yield { type: "error", message: `API error ${response.status}: ${text}` };
            return;
        }
        const body = response.body;
        if (!body) {
            yield { type: "error", message: "No response body" };
            return;
        }
        yield* this.parseSSE(body);
    }
    async *parseSSE(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const pendingToolCalls = new Map();
        let toolBlockIndex = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                let currentEvent = "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        currentEvent = "";
                        continue;
                    }
                    if (trimmed.startsWith("event: ")) {
                        currentEvent = trimmed.slice(7);
                        continue;
                    }
                    if (!trimmed.startsWith("data: "))
                        continue;
                    const data = trimmed.slice(6);
                    let parsed;
                    try {
                        parsed = JSON.parse(data);
                    }
                    catch {
                        continue;
                    }
                    switch (currentEvent) {
                        case "content_block_start": {
                            const cb = parsed.content_block;
                            if (cb?.type === "tool_use" && cb.id && cb.name) {
                                const idx = parsed.index ?? toolBlockIndex++;
                                pendingToolCalls.set(idx, {
                                    id: cb.id,
                                    type: "function",
                                    function: { name: cb.name, arguments: "" },
                                });
                            }
                            break;
                        }
                        case "content_block_delta": {
                            const delta = parsed.delta;
                            if (!delta)
                                break;
                            if (delta.type === "text_delta" && delta.text) {
                                yield { type: "content_delta", delta: delta.text };
                            }
                            else if (delta.type === "input_json_delta" && delta.partial_json) {
                                const idx = parsed.index ?? toolBlockIndex - 1;
                                const tc = pendingToolCalls.get(idx);
                                if (tc)
                                    tc.function.arguments += delta.partial_json;
                            }
                            break;
                        }
                        case "message_delta": {
                            const delta = parsed.delta;
                            if (delta?.stop_reason === "tool_use" || delta?.stop_reason === "end_turn" || delta?.stop_reason === "stop_sequence") {
                                if (pendingToolCalls.size > 0) {
                                    yield {
                                        type: "tool_calls_complete",
                                        toolCalls: Array.from(pendingToolCalls.values()),
                                    };
                                    pendingToolCalls.clear();
                                }
                                const usage = parsed.usage;
                                yield {
                                    type: "done",
                                    usage: usage ? {
                                        promptTokens: usage.input_tokens,
                                        completionTokens: usage.output_tokens,
                                        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                                    } : undefined,
                                };
                                return;
                            }
                            break;
                        }
                        case "message_stop": {
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
                        case "error": {
                            const error = parsed.error;
                            yield { type: "error", message: error?.message ?? "Anthropic API error" };
                            return;
                        }
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
        }
        finally {
            reader.releaseLock();
        }
    }
}
//# sourceMappingURL=anthropic-backend.js.map