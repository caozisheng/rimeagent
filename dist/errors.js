const codePolicies = {
    context_length_exceeded: "overflow",
    context_window_exceeded: "overflow",
    prompt_too_long: "overflow",
    abort_err: "interrupted",
    err_aborted: "interrupted",
    err_canceled: "interrupted",
    rate_limit_exceeded: "retryable",
    rate_limit_error: "retryable",
    overloaded_error: "retryable",
    server_error: "retryable",
    internal_server_error: "retryable",
    service_unavailable: "retryable",
    econnreset: "retryable",
    econnrefused: "retryable",
    econnaborted: "retryable", // Axios request timeout, not user cancellation.
    enotfound: "retryable",
    eai_again: "retryable",
    epipe: "retryable",
    etimedout: "retryable",
    esockettimedout: "retryable",
    und_err_socket: "retryable",
    und_err_connect_timeout: "retryable",
    und_err_headers_timeout: "retryable",
    und_err_body_timeout: "retryable",
    sse_interrupted: "retryable",
    stream_interrupted: "retryable",
    invalid_api_key: "nonretryable",
    authentication_error: "nonretryable",
    permission_denied: "nonretryable",
    permission_error: "nonretryable",
    invalid_request_error: "nonretryable",
    not_found_error: "nonretryable",
    insufficient_quota: "nonretryable",
};
const overflowMessage = /\b(?:maximum context length (?:is \d+|(?:has been )?exceeded)|context (?:length|window) (?:limit )?(?:has been )?exceeded|prompt is too long|input (?:is )?too long for (?:the )?context window)\b/i;
const interruptionMessage = /^(?:the )?(?:operation|request) (?:was |has been )?(?:aborted|cancelled|canceled)[.!]?$/i;
const networkMessage = /^(?:failed to fetch|fetch failed|network request failed|network error|networkerror when attempting to fetch resource[.]?|load failed|socket hang up|connection reset by peer)[.!]?$/i;
const timeoutMessage = /^(?:(?:the )?(?:request|connection|operation) (?:has )?timed out|(?:request|connection|operation) timeout|timeout(?: error)?)[.!]?$/i;
const streamMessage = /^(?:(?:sse|event|response) stream (?:was )?(?:interrupted|terminated|closed unexpectedly)|stream (?:ended|closed) (?:unexpectedly|before completion)|unexpected (?:end of (?:sse|event|response) stream|eof))[.!]?$/i;
function isNormalizedError(value) {
    if (typeof value !== "object" || value === null ||
        !("category" in value) || !("message" in value) || !("retryable" in value))
        return false;
    return ((value.category === "provider" || value.category === "context_overflow" ||
        value.category === "tool_failure" || value.category === "interrupted") &&
        typeof value.message === "string" &&
        typeof value.retryable === "boolean");
}
function httpStatus(value) {
    const status = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : undefined;
}
function inspectCode(value, facts) {
    if (typeof value !== "string")
        return;
    const code = value.toLowerCase();
    const policy = Object.hasOwn(codePolicies, code) ? codePolicies[code] : undefined;
    if (policy === "overflow")
        facts.overflow = true;
    if (policy === "interrupted")
        facts.interrupted = true;
    if (policy === "retryable")
        facts.retryableProvider = true;
    if (policy === "nonretryable")
        facts.nonretryableProvider = true;
}
function inspectText(text, facts) {
    facts.message ??= text.trim() ? text : undefined;
    inspectCode(text.trim(), facts);
    if (overflowMessage.test(text))
        facts.overflow = true;
    if (interruptionMessage.test(text))
        facts.interrupted = true;
    if (networkMessage.test(text) || timeoutMessage.test(text) || streamMessage.test(text)) {
        facts.retryableProvider = true;
    }
}
function inspectError(value, facts, seen) {
    if (typeof value === "string") {
        // Accept legacy transport messages without guessing status from arbitrary prose.
        const legacy = /^API error (\d{3}):\s*([\s\S]*)$/.exec(value);
        if (legacy) {
            facts.status ??= httpStatus(legacy[1]);
            inspectText(value, facts);
            inspectError(legacy[2], facts, seen);
            return;
        }
        if (value.trimStart().startsWith("{")) {
            try {
                inspectError(JSON.parse(value), facts, seen);
            }
            catch {
                // Non-JSON provider bodies still carry useful human-readable messages.
            }
        }
        inspectText(value, facts);
        return;
    }
    if (typeof value !== "object" || value === null || seen.has(value))
        return;
    seen.add(value);
    // Fields remain unknown until individually checked at this provider boundary.
    const envelope = value;
    facts.status ??= httpStatus(envelope.status) ?? httpStatus(envelope.statusCode);
    inspectCode(envelope.code, facts);
    inspectCode(envelope.type, facts);
    if (envelope.name === "AbortError")
        facts.interrupted = true;
    if (envelope.name === "TimeoutError" || envelope.name === "NetworkError" || envelope.name === "StreamInterruptedError") {
        facts.retryableProvider = true;
    }
    if (typeof envelope.message === "string")
        inspectError(envelope.message, facts, seen);
    // Error.cause and common SDK response envelopes are inspected, never serialized.
    for (const key of ["error", "body", "responseBody", "response", "data", "cause"]) {
        inspectError(envelope[key], facts, seen);
    }
}
/** Classify one failure; retry execution and recovery remain the runtime's responsibility. */
export function normalizeError(err, ctx) {
    if (isNormalizedError(err))
        return err;
    const facts = {
        overflow: false,
        interrupted: false,
        retryableProvider: false,
        nonretryableProvider: false,
    };
    inspectError(err, facts, new WeakSet());
    const message = facts.message ?? (err !== undefined && typeof err !== "object" ? String(err).trim() || "Unknown error" : "Unknown error");
    let category = "provider";
    let retryable = false;
    if (facts.overflow) {
        category = "context_overflow";
    }
    else if (facts.interrupted) {
        category = "interrupted";
    }
    else if (ctx?.toolName !== undefined) {
        category = "tool_failure";
    }
    else if (facts.status !== undefined) {
        // Permanent provider codes override otherwise retryable HTTP statuses.
        retryable = !facts.nonretryableProvider && (facts.status === 408 || facts.status === 429 || facts.status >= 500);
    }
    else {
        retryable = facts.retryableProvider && !facts.nonretryableProvider;
    }
    return { category, message, retryable, cause: err };
}
//# sourceMappingURL=errors.js.map