import { prepareAgentRequest, runAgentLoop, runPreparedAgentLoop } from "../service";
import { normalizeError } from "../errors";
import { isNormalizedError } from "../store/validation";
function errorEvent(cause) {
    const { category, message, retryable } = normalizeError(cause);
    return { type: "error", message, error: { category, message, retryable } };
}
/** Recovery owns only request attempts: no history, tools, or iteration advancement. */
export async function* runIterationRequests(input, hooks) {
    if (!hooks.beforeRequest && !hooks.onContextOverflow) {
        // This path deliberately retains the legacy error and cleanup behavior.
        yield* runAgentLoop(input.params);
        return;
    }
    for (let attempt = 0; attempt <= 3; attempt++) {
        if (input.params.signal?.aborted)
            return;
        yield { kind: "request_attempt_started" };
        if (input.params.signal?.aborted)
            return;
        let failure;
        let request;
        try {
            request = hooks.beforeRequest
                ? await hooks.beforeRequest({ ...input, attempt })
                : prepareAgentRequest(input.params);
        }
        catch (cause) {
            hooks.onPreparationError?.(cause);
            // Storage/configuration failures are not provider failures or recoverable overflow.
            if (!isNormalizedError(cause) || cause.category !== "context_overflow")
                throw cause;
            failure = errorEvent(cause);
        }
        if (input.params.signal?.aborted)
            return;
        if (request) {
            for (const event of request.events ?? []) {
                yield event;
                if (input.params.signal?.aborted)
                    return;
            }
            // Breaking this loop closes the previous provider before recovery is consulted.
            let confirmed = false;
            let delivering = false;
            try {
                for await (const event of runPreparedAgentLoop(request, input.params.signal)) {
                    if (input.params.signal?.aborted)
                        return;
                    if (event.type === "error") {
                        failure = event;
                        break;
                    }
                    if (event.type === "message_end")
                        confirmed = true;
                    delivering = true;
                    yield event;
                    delivering = false;
                }
            }
            catch (cause) {
                // A return/throw while suspended at yield is consumer closure, not a request failure.
                if (delivering || confirmed || failure || !isNormalizedError(cause))
                    throw cause;
                failure = errorEvent(cause);
            }
        }
        if (!failure || input.params.signal?.aborted)
            return;
        if (failure.error.category === "context_overflow" && attempt < 3 &&
            await hooks.onContextOverflow?.(failure.error, attempt)) {
            continue;
        }
        yield failure;
        return;
    }
}
//# sourceMappingURL=request-attempt.js.map