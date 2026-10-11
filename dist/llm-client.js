import { RimeAgentBackend } from "./llm-backend";
export { resolveProvider } from "./llm-backend";
const baselineBackend = new RimeAgentBackend();
let customBackend = null;
const registrations = [];
export function registerLLMBackend(backend) {
    customBackend = backend;
}
/** Register a config-specific route; the newest matching registration wins. */
export function registerLLMBackendFor(predicate, backend) {
    if (registrations.some((registration) => registration.predicate === predicate)) {
        throw new Error("LLM backend predicate is already registered");
    }
    const registration = { predicate, backend };
    registrations.push(registration);
    return () => {
        const index = registrations.indexOf(registration);
        if (index !== -1)
            registrations.splice(index, 1);
    };
}
export function getLLMBackend(config) {
    for (let index = registrations.length - 1; index >= 0; index--) {
        const registration = registrations[index];
        if (registration.predicate(config))
            return registration.backend;
    }
    return customBackend ?? baselineBackend;
}
export function streamChatCompletion(config, messages, signal, tools) {
    const backend = getLLMBackend(config);
    return backend.streamChat(config, messages, signal, tools);
}
//# sourceMappingURL=llm-client.js.map