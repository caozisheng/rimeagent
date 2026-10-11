import { nanoid } from "nanoid";
import { InMemorySessionStore } from "../store/session-store";
import { computeContextDigest } from "../store/checkpoint";
import { createAgentRuntimeEvent } from "../events";
import { normalizeError } from "../errors";
import { createToolRegistry } from "../tool-registry";
import { runSessionIterations } from "./iteration";
import { RuntimeHistory, assertCompleteHistory } from "./history";
function createRuntime(config, compatibility) {
    if (!compatibility && (!config.sessionId || !config.expertRoleId))
        throw new TypeError("Runtime requires sessionId and expertRoleId");
    const maxIterations = config.maxIterations ?? 10;
    if (!compatibility && (!Number.isSafeInteger(maxIterations) || maxIterations < 0))
        throw new TypeError("maxIterations must be a nonnegative safe integer");
    const history = new RuntimeHistory(config.sessionStore, config.sessionId);
    const registry = createToolRegistry();
    for (const tool of config.tools) {
        if (registry.get(tool.name))
            throw new TypeError(`Duplicate runtime tool: ${tool.name}`);
        registry.register(tool);
    }
    let state = "idle";
    let active;
    let llmConfig = config.llmConfig;
    let activeRoleId = config.activeRoleId ?? config.expertRoleId;
    async function executeToolCall(call) {
        const tool = registry.get(call.function.name);
        if (tool?.annotations?.requiresApproval || tool?.annotations?.destructive || tool?.requiresConfirmation) {
            return { success: false, message: "Tool requires approval; approval execution is not available in this runtime version" };
        }
        return registry.executeToolCall(call);
    }
    async function* run(userMessage, callerSignal) {
        if (active)
            throw new Error("An agent run is already active");
        if (typeof userMessage !== "string")
            throw new TypeError("User message must be a string");
        const controller = new AbortController();
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        active = controller;
        state = "running";
        const runId = nanoid();
        const persistenceFailures = history.persistenceFailures;
        let seq = 0;
        let started = false;
        let terminal = false;
        let lastCheckpoint;
        let iterator;
        const event = (payload) => {
            const next = ++seq;
            if (compatibility) {
                // Internal bridge only: preserve the legacy callback value without strict v2 serialization.
                return { v: 2, runId, seq: next, ts: Date.now(), type: "kind" in payload ? payload.kind : payload.type, payload };
            }
            return createAgentRuntimeEvent(runId, next, Date.now(), payload);
        };
        async function interrupt() {
            lastCheckpoint = await history.checkpoint();
            await history.append({ kind: "run_interrupted", runId, cause: "interrupted", lastDurableBoundary: lastCheckpoint.checkpointId });
            terminal = true;
            state = "interrupted";
            return event({ kind: "run_interrupted", cause: "interrupted" });
        }
        try {
            const messages = compatibility ? [...compatibility.params.messages] : await history.load(config.initialMessages);
            if (!compatibility)
                assertCompleteHistory(messages);
            await history.append({ kind: "run_started", runId });
            started = true;
            if (!compatibility) {
                await history.append({ kind: "user_message", content: userMessage });
                messages.push({ id: nanoid(), role: "user", content: userMessage, createdAt: Date.now() });
            }
            yield event({ kind: "run_started", sessionId: config.sessionId });
            if (signal.aborted) {
                yield await interrupt();
                return;
            }
            const params = compatibility ? { ...compatibility.params, signal } : {
                messages, llmConfig, expertRoleId: config.expertRoleId, activeRoleId,
                identityPrompt: config.identityPrompt, workRules: config.workRules, customLayers: config.customLayers,
                locale: config.locale, switchRoleToolDef: config.switchRoleToolDef, tools: registry.getDefinitions(), signal,
            };
            const sessionConfig = compatibility?.config ?? {
                maxIterations, onToolCall: executeToolCall,
                onRoleSwitch(roleId) {
                    activeRoleId = roleId;
                    const updated = config.hooks?.onRoleSwitch?.(roleId);
                    if (updated)
                        llmConfig = updated;
                    return updated;
                },
            };
            iterator = runSessionIterations(params, sessionConfig, {
                legacyToolResults: compatibility !== undefined,
                beforeIteration: compatibility ? undefined : failures => {
                    const dynamicContext = config.hooks?.buildDynamicContext?.() ?? null;
                    const rag = config.hooks?.buildRagContext?.(userMessage, {
                        appState: dynamicContext ?? undefined, failedTools: failures.map(f => f.toolName),
                    }) ?? "";
                    const recovery = failures.length ? config.hooks?.buildErrorRecovery?.(failures) : undefined;
                    return { dynamicContext, ragContext: recovery ? [rag, recovery].filter(Boolean).join("\n\n") : rag || null };
                },
                onMessage: async (message) => {
                    if (compatibility && message.role === "tool") {
                        const result = JSON.parse(message.content);
                        // Private legacy store retains a summary; the kernel keeps the full original model history.
                        await history.append({ kind: "tool_result", toolCallId: message.toolCallId,
                            result: { success: result.success, message: result.message } });
                    }
                    else
                        await history.recordMessage(message);
                },
                onToolStart: async (call) => {
                    const argsDigest = computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
                    await history.append({ kind: "tool_call", toolCallId: call.id, name: call.function.name, argsDigest });
                },
            });
            let outcome;
            while (true) {
                const next = await iterator.next();
                if (next.done) {
                    outcome = next.value;
                    break;
                }
                const payload = next.value;
                if (signal.aborted) {
                    yield await interrupt();
                    return;
                }
                if ("kind" in payload && payload.kind === "iteration_end")
                    lastCheckpoint = await history.checkpoint();
                if ("type" in payload && payload.type === "message_end" && payload.usage) {
                    await history.append({ kind: "usage", runId, usage: payload.usage });
                }
                yield event(payload);
            }
            if (signal.aborted || outcome.reason === "interrupted") {
                yield await interrupt();
                return;
            }
            if (outcome.reason === "error") {
                const error = normalizeError(outcome.errorMessage ?? "Model request failed");
                await history.append({ kind: "run_failed", runId, error });
                terminal = true;
                state = "settled";
                yield event({ kind: "run_failed", error });
                return;
            }
            const reason = outcome.reason;
            await history.append({ kind: "run_completed", runId, reason, iterations: outcome.iterations });
            terminal = true;
            state = "settled";
            yield event({ kind: "run_completed", reason, iterations: outcome.iterations });
        }
        catch (cause) {
            if (history.persistenceFailures !== persistenceFailures) {
                terminal = true;
                state = "settled";
                if (started) {
                    try {
                        await history.append({ kind: "run_failed", runId, error: normalizeError(cause) });
                    }
                    catch (recordFailure) {
                        throw new AggregateError([cause, recordFailure], "Failed to persist run failure", { cause });
                    }
                }
                throw cause;
            }
            if (compatibility)
                throw cause;
            if (signal.aborted) {
                yield await interrupt();
                return;
            }
            const error = normalizeError(cause);
            await history.append({ kind: "run_failed", runId, error });
            terminal = true;
            state = "settled";
            yield event({ kind: "run_failed", error });
        }
        finally {
            controller.abort();
            try {
                let cleanupFailure;
                let cleanupFailed = false;
                try {
                    if (iterator)
                        await iterator.return({ reason: "interrupted", iterations: 0 });
                }
                catch (cause) {
                    cleanupFailure = cause;
                    cleanupFailed = true;
                }
                try {
                    if (started && !terminal)
                        await interrupt();
                }
                catch (boundaryFailure) {
                    if (cleanupFailed)
                        throw new AggregateError([cleanupFailure, boundaryFailure], "Provider cleanup and interruption persistence failed");
                    throw boundaryFailure;
                }
                if (cleanupFailed)
                    throw cleanupFailure;
            }
            finally {
                active = undefined;
                if (!terminal)
                    state = "interrupted";
            }
        }
    }
    return {
        get state() { return state; },
        run,
        checkpoint: label => history.checkpoint(label),
        abort(reason) { active?.abort(reason); },
    };
}
/** Run lifecycle and confirmed-message history; disk recovery is added in Phase 4. */
export function createAgentRuntime(config) {
    return createRuntime(config);
}
/** Internal bridge: the legacy session has no additional user input or public v2 events. */
export function createSessionRuntime(params, config) {
    const runtime = createRuntime({ sessionId: nanoid(), sessionStore: new InMemorySessionStore(),
        llmConfig: params.llmConfig, expertRoleId: params.expertRoleId, tools: [], maxIterations: config.maxIterations }, { params, config });
    return runtime.run("", params.signal);
}
//# sourceMappingURL=runtime.js.map