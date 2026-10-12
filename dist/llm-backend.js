import { normalizeError } from "./errors";
import { streamAnthropicChat } from "./anthropic-backend";
import { validateMaxOutputTokens } from "./anthropic-adapter";
export function shouldUseDirect(config) {
    if (config.directMode !== undefined)
        return config.directMode;
    if (typeof window === "undefined")
        return false;
    return !!window.__TAURI__ ||
        navigator.userAgent.includes("wv") ||
        typeof window.__CAPACITOR__ !== "undefined";
}
export function resolveProvider(config) {
    if (config.provider && config.provider !== "custom")
        return config.provider;
    try {
        if (new URL(config.baseUrl).hostname === "api.anthropic.com")
            return "anthropic";
    }
    catch { /* fallback */ }
    return "openai";
}
export class RimeAgentBackend {
    type = "rimeagent";
    async *streamChat(config, messages, signal, tools) {
        validateMaxOutputTokens(config);
        const direct = shouldUseDirect(config);
        // Only the native host speaks Anthropic here; third-party proxies stay OpenAI-compatible.
        if (resolveProvider(config) === "anthropic") {
            let nativeHost = false;
            try {
                nativeHost = new URL(config.baseUrl).hostname === "api.anthropic.com";
            }
            catch { /* relative or malformed URLs use the compatible transport */ }
            if (nativeHost) {
                yield* streamAnthropicChat(config, messages, direct, signal, tools);
                return;
            }
        }
        const url = direct
            ? config.baseUrl.replace(/\/+$/, "") + "/chat/completions"
            : "/api/ai/chat";
        let response;
        try {
            const body = direct
                ? { model: config.model, messages, stream: true }
                : { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, messages };
            if (config.maxOutputTokens !== undefined) {
                body[direct ? "max_tokens" : "maxTokens"] = config.maxOutputTokens;
            }
            if (tools && tools.length > 0) {
                body.tools = tools;
                if (direct)
                    body.tool_choice = "auto";
            }
            const headers = { "Content-Type": "application/json" };
            if (direct) {
                headers.Authorization = `Bearer ${config.apiKey}`;
            }
            response = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : "Network error";
            console.error("[LLM] fetch failed:", msg);
            yield { type: "error", message: msg, error: normalizeError(err) };
            return;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "Unknown error");
            const message = `API error ${response.status}: ${text}`;
            yield { type: "error", message, error: normalizeError({ status: response.status, message, responseBody: text }) };
            return;
        }
        const responseBody = response.body;
        if (!responseBody) {
            yield { type: "error", message: "No response body", error: normalizeError("No response body") };
            return;
        }
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const pendingToolCalls = new Map();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                const text = decoder.decode(value, { stream: true });
                buffer += text;
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(":"))
                        continue;
                    if (!trimmed.startsWith("data: "))
                        continue;
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
                            for (const tc of delta.tool_calls) {
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
                                }
                                else {
                                    const existing = pendingToolCalls.get(idx);
                                    if (tc.id)
                                        existing.id = tc.id;
                                    if (tc.function?.name)
                                        existing.function.name = tc.function.name;
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
                    }
                    catch {
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
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Network error";
            yield { type: "error", message, error: normalizeError(err) };
        }
        finally {
            reader.releaseLock();
        }
    }
}
//# sourceMappingURL=llm-backend.js.map