import { jsonSchema, streamText } from "ai";
import { normalizeError } from "../errors";
function convertMessages(messages) {
    const names = new Map();
    return messages.map((message) => {
        if (message.role === "assistant") {
            if (!message.tool_calls?.length)
                return { role: "assistant", content: message.content ?? "" };
            const content = [];
            if (message.content)
                content.push({ type: "text", text: message.content });
            for (const call of message.tool_calls) {
                names.set(call.id, call.function.name);
                content.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name,
                    input: JSON.parse(call.function.arguments) });
            }
            return { role: "assistant", content };
        }
        if (message.role === "tool") {
            const id = message.tool_call_id;
            const name = id ? names.get(id) : undefined;
            if (!id || !name)
                throw new Error("Tool result has no matching assistant tool call");
            return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name,
                        output: { type: "text", value: message.content ?? "" } }] };
        }
        return { role: message.role, content: message.content ?? "" };
    });
}
function mapUsage(usage, metadata) {
    const mapped = {
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
    };
    const read = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens;
    let write = usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens;
    let cost = usage.cost;
    for (const provider of Object.values(metadata ?? {})) {
        if (cost === undefined && typeof provider.cost === "number")
            cost = provider.cost;
        const cached = provider.cacheWriteTokens ?? provider.cacheCreationInputTokens;
        if (write === undefined && typeof cached === "number")
            write = cached;
    }
    if (read !== undefined)
        mapped.cacheReadTokens = read;
    if (write !== undefined)
        mapped.cacheWriteTokens = write;
    if (cost !== undefined)
        mapped.cost = cost;
    return mapped;
}
/** Single-turn transport. Model/provider/proxy construction belongs to the host. */
export class VercelAIBackend {
    resolveModel;
    type = "vercel";
    constructor(resolveModel) {
        this.resolveModel = resolveModel;
    }
    async *streamChat(config, messages, signal, tools) {
        const controller = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
            if (signal?.aborted)
                throw new DOMException("The operation was aborted", "AbortError");
            let converted;
            try {
                converted = convertMessages(messages);
            }
            catch (cause) {
                const error = normalizeError(cause, { toolName: "conversation" });
                yield { type: "error", message: error.message, error };
                return;
            }
            // Leading engine-owned system layers use the SDK's dedicated system channel.
            let systemCount = 0;
            let system;
            while (converted[systemCount]?.role === "system") {
                const content = converted[systemCount].content;
                system = system === undefined ? content : `${system}\n\n${content}`;
                systemCount++;
            }
            const model = await this.resolveModel(config);
            const sdkTools = Object.create(null);
            for (const definition of tools ?? []) {
                const tool = definition.function;
                sdkTools[tool.name] = { description: tool.description, inputSchema: jsonSchema(tool.parameters) };
            }
            const result = streamText({ model, system, messages: systemCount ? converted.slice(systemCount) : converted, abortSignal: requestSignal,
                tools: sdkTools, maxRetries: 0, onError: () => { } });
            const indices = new Map();
            const calls = new Map();
            let metadata;
            for await (const part of result.fullStream) {
                switch (part.type) {
                    case "text-delta":
                        yield { type: "content_delta", delta: part.text };
                        break;
                    case "tool-input-start": {
                        const index = indices.size;
                        indices.set(part.id, index);
                        yield { type: "tool_calls_delta", index, id: part.id, functionName: part.toolName };
                        break;
                    }
                    case "tool-input-delta": {
                        const index = indices.get(part.id);
                        if (index === undefined)
                            throw new Error("Tool input delta has no matching start");
                        yield { type: "tool_calls_delta", index, argumentsDelta: part.delta };
                        break;
                    }
                    case "tool-call":
                        if (part.invalid) {
                            const error = normalizeError(part.error, { toolName: part.toolName });
                            yield { type: "error", message: error.message, error };
                            return;
                        }
                        if (!indices.has(part.toolCallId))
                            indices.set(part.toolCallId, indices.size);
                        calls.set(part.toolCallId, { id: part.toolCallId, type: "function", function: {
                                name: part.toolName, arguments: JSON.stringify(part.input),
                            } });
                        break;
                    case "finish-step":
                        metadata = part.providerMetadata;
                        break;
                    case "finish":
                        if (indices.size !== calls.size) {
                            const error = normalizeError(new Error("Tool input ended without a complete tool call"), { toolName: "stream" });
                            yield { type: "error", message: error.message, error };
                            return;
                        }
                        if (calls.size) {
                            const ordered = [...calls.values()].sort((a, b) => indices.get(a.id) - indices.get(b.id));
                            yield { type: "tool_calls_complete", toolCalls: ordered };
                        }
                        yield { type: "done", usage: mapUsage(part.totalUsage, metadata) };
                        return;
                    case "abort": {
                        const error = normalizeError(new DOMException("The operation was aborted", "AbortError"));
                        yield { type: "error", message: error.message, error };
                        return;
                    }
                    case "error": {
                        const error = normalizeError(part.error);
                        yield { type: "error", message: error.message, error };
                        return;
                    }
                }
            }
            const error = normalizeError(new Error("SSE stream interrupted"));
            yield { type: "error", message: error.message, error };
        }
        catch (cause) {
            const error = signal?.aborted
                ? normalizeError(new DOMException("The operation was aborted", "AbortError"))
                : normalizeError(cause);
            yield { type: "error", message: error.message, error };
        }
        finally {
            controller.abort();
        }
    }
}
//# sourceMappingURL=vercel.js.map