import { normalizeError } from "./errors";
import { convertTools, convertMessages, validateMaxOutputTokens } from "./anthropic-adapter";
/** Internal Anthropic transport used by RimeAgentBackend. */
export async function* streamAnthropicChat(config, messages, direct, signal, tools) {
    validateMaxOutputTokens(config);
    const { system, messages: anthropicMessages } = convertMessages(messages);
    const apiBody = {
        model: config.model,
        max_tokens: config.maxOutputTokens ?? config.contextLength ?? 8192,
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
        yield { type: "error", message: msg, error: normalizeError(err) };
        return;
    }
    if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        const message = `API error ${response.status}: ${text}`;
        yield { type: "error", message, error: normalizeError({ status: response.status, message, responseBody: text }) };
        return;
    }
    const body = response.body;
    if (!body) {
        yield { type: "error", message: "No response body", error: normalizeError("No response body") };
        return;
    }
    yield* parseSSE(body);
}
async function* parseSSE(body) {
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
                        const message = error?.message ?? "Anthropic API error";
                        yield { type: "error", message, error: normalizeError(error ?? message) };
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
    catch (err) {
        const message = err instanceof Error ? err.message : "Network error";
        yield { type: "error", message, error: normalizeError(err) };
    }
    finally {
        reader.releaseLock();
    }
}
//# sourceMappingURL=anthropic-backend.js.map