import { CloudLLMBackend } from "./llm-backend";
import { AnthropicLLMBackend } from "./anthropic-backend";
const openaiBackend = new CloudLLMBackend();
const anthropicBackend = new AnthropicLLMBackend();
let customBackend = null;
export function registerLLMBackend(backend) {
    customBackend = backend;
}
export function resolveProvider(config) {
    if (config.provider && config.provider !== "custom")
        return config.provider;
    try {
        const host = new URL(config.baseUrl).hostname;
        if (host === "api.anthropic.com")
            return "anthropic";
    }
    catch { /* fallback */ }
    return "openai";
}
function isNativeAnthropicHost(baseUrl) {
    try {
        return new URL(baseUrl).hostname === "api.anthropic.com";
    }
    catch {
        return false;
    }
}
export function getLLMBackend(config) {
    if (customBackend)
        return customBackend;
    const provider = resolveProvider(config);
    // Only use native Anthropic backend for api.anthropic.com.
    // Third-party proxies expose OpenAI-compatible endpoints even for Claude models.
    if (provider === "anthropic" && isNativeAnthropicHost(config.baseUrl))
        return anthropicBackend;
    return openaiBackend;
}
export function streamChatCompletion(config, messages, signal, tools) {
    const backend = getLLMBackend(config);
    return backend.streamChat(config, messages, signal, tools);
}
//# sourceMappingURL=llm-client.js.map