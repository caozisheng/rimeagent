import { nanoid } from "nanoid";
import { InMemorySessionStore } from "../store/session-store";
import { computeContextDigest } from "../store/checkpoint";
import { InMemoryArtifactStore } from "../store/artifact-store";
import { createAgentRuntimeEvent } from "../events";
import { normalizeError } from "../errors";
import { createToolRegistry } from "../tool-registry";
import { runSessionIterations } from "./iteration";
import { RuntimeHistory, assertCompleteHistory, projectMessages } from "./history";
import { assertNewRun, loadResumeState, rejectRecovery } from "./recovery";
import { createRuntimeRequestContext } from "./request-context";
import { InMemoryLedger } from "./ledger";
import { createToolExecutor } from "./executor";
function createRuntime(config, compatibility) {
    if (!compatibility && (!config.sessionId || !config.expertRoleId))
        throw new TypeError("Runtime requires sessionId and expertRoleId");
    const maxIterations = config.maxIterations ?? 10;
    if (!compatibility && (!Number.isSafeInteger(maxIterations) || maxIterations < 0))
        throw new TypeError("maxIterations must be a nonnegative safe integer");
    const history = new RuntimeHistory(config.sessionStore, config.sessionId);
    const ledger = config.ledger ?? new InMemoryLedger();
    const artifactStore = config.artifactStore ?? new InMemoryArtifactStore();
    const executor = createToolExecutor({ sessionId: config.sessionId, tools: config.tools, ledger, artifactStore });
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
    let activeCheckpoint;
    async function* execute(userInput, resumeId, callerSignal) {
        if (active)
            throw new Error("An agent run is already active");
        if (resumeId === undefined && typeof userInput !== "string")
            throw new TypeError("User message must be a string");
        const controller = new AbortController();
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        active = controller;
        const previousState = state;
        const runId = resumeId ?? nanoid();
        const persistenceFailures = history.persistenceFailures;
        let ledgerFailed = false;
        let seq = 0;
        let iteration = 0;
        let phase = "model";
        let started = false;
        let validated = false;
        let terminal = false;
        let lastCheckpoint;
        let iterator;
        const nextSeq = () => ++seq;
        // Message hooks can settle the phase while the iteration generator is suspended.
        const hasSettledResponse = () => phase === "settled";
        async function recordLedger(event) {
            if (compatibility)
                return;
            try {
                await ledger.append({ runId, seq: nextSeq(), ts: Date.now(), event });
            }
            catch (cause) {
                ledgerFailed = true;
                throw cause;
            }
        }
        async function saveCursor() {
            if (compatibility)
                return;
            await history.append({ kind: "run_state", runId, seq, iteration, phase, activeRoleId,
                ...(lastCheckpoint === undefined ? {} : { checkpointId: lastCheckpoint.checkpointId }) });
        }
        async function boundary(label) {
            const facts = config.hooks?.getProjectFacts?.();
            lastCheckpoint = await history.checkpoint(label, compatibility ? undefined : {
                runId, seq: nextSeq(), ...(facts === undefined ? {} : { projectFacts: facts })
            });
            return lastCheckpoint;
        }
        async function assertProjectBoundary() {
            if (!lastCheckpoint || compatibility)
                return;
            const facts = config.hooks?.getProjectFacts?.();
            if (lastCheckpoint.projectRevision !== undefined && facts?.projectRevision !== lastCheckpoint.projectRevision)
                rejectRecovery("Project revision changed before external execution");
            if (lastCheckpoint.projectId !== undefined && facts?.projectId !== lastCheckpoint.projectId)
                rejectRecovery("Project identity changed before external execution");
        }
        async function assertHostBoundary() {
            if (!lastCheckpoint || compatibility)
                return;
            await assertProjectBoundary();
            if (computeContextDigest(projectMessages(await history.entries())) !== lastCheckpoint.contextDigest)
                rejectRecovery("Context digest changed before external execution");
        }
        async function event(payload) {
            const next = nextSeq();
            if (compatibility)
                return { v: 2, runId, seq: next, ts: Date.now(),
                    type: "kind" in payload ? payload.kind : payload.type, payload };
            const result = createAgentRuntimeEvent(runId, next, Date.now(), payload);
            await saveCursor();
            return result;
        }
        async function interrupt(cause = "interrupted") {
            // Do not adopt unrelated host changes while settling an interruption.
            if (!lastCheckpoint || compatibility)
                await boundary();
            await history.append({ kind: "run_interrupted", runId, cause, lastDurableBoundary: lastCheckpoint.checkpointId });
            await recordLedger({ kind: "terminal", status: "interrupted" });
            const result = await event({ kind: "run_interrupted", cause });
            terminal = true;
            state = "interrupted";
            return result;
        }
        try {
            let restored;
            let messages;
            if (resumeId !== undefined) {
                restored = await loadResumeState(history, ledger, resumeId, config.hooks?.getProjectFacts?.(), artifactStore);
                messages = restored.messages;
                seq = restored.seq;
                iteration = restored.iteration;
                phase = restored.phase;
                activeRoleId = restored.activeRoleId;
                lastCheckpoint = restored.checkpoint;
                llmConfig = config.hooks?.onRoleSwitch?.(activeRoleId) || config.llmConfig;
            }
            else {
                if (!compatibility)
                    assertNewRun(await history.entries());
                if (!compatibility && config.initialMessages)
                    assertCompleteHistory(config.initialMessages);
                messages = compatibility ? [...compatibility.params.messages] : await history.load(config.initialMessages);
                if (!compatibility) {
                    assertCompleteHistory(messages);
                    activeRoleId = config.activeRoleId ?? config.expertRoleId;
                    llmConfig = config.llmConfig;
                }
            }
            validated = true;
            state = "running";
            activeCheckpoint = boundary;
            const userMessage = restored?.userMessage ?? userInput;
            if (!restored) {
                await history.append({ kind: "run_started", runId });
                started = true;
                if (!compatibility) {
                    await history.append({ kind: "user_message", content: userMessage });
                    messages.push({ id: nanoid(), role: "user", content: userMessage, createdAt: Date.now() });
                }
            }
            else
                started = true;
            await boundary();
            yield await event({ kind: restored ? "run_resumed" : "run_started", sessionId: config.sessionId });
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
                maxIterations,
                async onToolCall(call) {
                    try {
                        return await executor.execute(call, { runId, nextSeq, signal });
                    }
                    catch (cause) {
                        // Executor persistence errors must remain rejected, not a false completion.
                        if (!(typeof cause === "object" && cause !== null && "category" in cause))
                            ledgerFailed = true;
                        throw cause;
                    }
                },
                onRoleSwitch(roleId) {
                    activeRoleId = roleId;
                    const updated = config.hooks?.onRoleSwitch?.(roleId);
                    if (updated)
                        llmConfig = updated;
                    return updated;
                },
            };
            const requestContext = compatibility ? undefined : createRuntimeRequestContext({ config, artifactStore, signal,
                assertBoundary: assertHostBoundary, recordLedger, onPersistenceFailure: () => { ledgerFailed = true; },
                hasPersistenceFailure: () => ledgerFailed || history.persistenceFailures !== persistenceFailures });
            let outcome;
            if (hasSettledResponse())
                outcome = { reason: "response", iterations: iteration + 1 };
            else {
                iterator = runSessionIterations(params, sessionConfig, {
                    legacyToolResults: compatibility !== undefined,
                    initialState: restored ? { iterationOffset: iteration, pendingToolCalls: restored.pendingToolCalls, failures: restored.failures } : undefined,
                    beforeRequest: requestContext?.prepare,
                    onContextOverflow: requestContext?.recover,
                    onPreparationError: requestContext?.guardPreparationError,
                    onMessage: async (message, usage) => {
                        if (!compatibility && message.role === "assistant") {
                            await recordLedger({ kind: "model_call", provider: llmConfig.provider ?? "openai", model: llmConfig.model,
                                requestIndex: iteration, usage: usage ?? {} });
                            if (usage)
                                await history.append({ kind: "usage", runId, usage });
                            await assertHostBoundary();
                        }
                        if (compatibility && message.role === "tool") {
                            const result = JSON.parse(message.content);
                            await history.append({ kind: "tool_result", toolCallId: message.toolCallId, result: { success: result.success, message: result.message } });
                        }
                        else {
                            let artifactId;
                            if (message.role === "tool" && message.toolCallId) {
                                try {
                                    const execution = await ledger.getToolExecution(message.toolCallId);
                                    if (execution?.event.kind === "tool_exec")
                                        artifactId = execution.event.artifactId;
                                }
                                catch (cause) {
                                    ledgerFailed = true;
                                    throw cause;
                                }
                            }
                            await history.recordMessage(message, artifactId);
                        }
                        if (!compatibility) {
                            if (message.role === "assistant")
                                phase = message.toolCalls?.length ? "tools" : "settled";
                            if (message.role === "assistant")
                                await assertProjectBoundary();
                            await boundary();
                            await saveCursor();
                        }
                    },
                    onToolStart: async (call) => {
                        await assertHostBoundary();
                        await boundary();
                        const argsDigest = computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
                        await history.append({ kind: "tool_call", toolCallId: call.id, name: call.function.name, argsDigest });
                    },
                });
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
                    if ("kind" in payload && payload.kind === "iteration_start") {
                        await assertHostBoundary();
                        iteration = payload.iteration;
                        phase = "model";
                        await boundary();
                    }
                    if ("kind" in payload && payload.kind === "iteration_end") {
                        if (phase !== "settled") {
                            phase = "model";
                            iteration = payload.iteration + 1;
                        }
                        await boundary();
                    }
                    yield await event(payload);
                }
            }
            if (signal.aborted || outcome.reason === "interrupted") {
                yield await interrupt();
                return;
            }
            if (outcome.reason === "error") {
                const error = outcome.error ?? normalizeError(outcome.errorMessage ?? "Model request failed");
                if (error.category === "context_overflow") {
                    await history.append({ kind: "error", error });
                    yield await interrupt("context_overflow");
                    return;
                }
                await recordLedger({ kind: "terminal", status: "failed" });
                await history.append({ kind: "run_failed", runId, error });
                phase = "settled";
                const result = await event({ kind: "run_failed", error });
                terminal = true;
                state = "settled";
                yield result;
                return;
            }
            phase = "settled";
            const result = await event({ kind: "run_completed", reason: outcome.reason, iterations: outcome.iterations });
            await recordLedger({ kind: "terminal", status: "completed" });
            await history.append({ kind: "run_completed", runId, reason: outcome.reason, iterations: outcome.iterations });
            terminal = true;
            state = "settled";
            yield result;
        }
        catch (cause) {
            if (!validated) {
                state = previousState;
                throw cause;
            }
            if (history.persistenceFailures !== persistenceFailures || ledgerFailed) {
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
            if (error.category === "context_overflow") {
                await history.append({ kind: "error", error });
                yield await event({ type: "error", message: error.message });
                yield await interrupt("context_overflow");
                return;
            }
            await recordLedger({ kind: "terminal", status: "failed" });
            await history.append({ kind: "run_failed", runId, error });
            phase = "settled";
            const result = await event({ kind: "run_failed", error });
            terminal = true;
            state = "settled";
            yield result;
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
                activeCheckpoint = undefined;
                if (validated && !terminal)
                    state = "interrupted";
            }
        }
    }
    return {
        get state() { return state; },
        run: (message, signal) => execute(message, undefined, signal),
        resume: (runId, signal) => execute(undefined, runId, signal),
        checkpoint: label => activeCheckpoint ? activeCheckpoint(label) : history.checkpoint(label),
        abort(reason) { active?.abort(reason); },
    };
}
/** Durable run lifecycle and confirmed-message history. */
export function createAgentRuntime(config) {
    return createRuntime(config);
}
/** Internal bridge: legacy sessions add no user input and expose their original callback values. */
export function createSessionRuntime(params, config) {
    const runtime = createRuntime({ sessionId: nanoid(), sessionStore: new InMemorySessionStore(),
        llmConfig: params.llmConfig, expertRoleId: params.expertRoleId, tools: [], maxIterations: config.maxIterations }, { params, config });
    return runtime.run("", params.signal);
}
//# sourceMappingURL=runtime.js.map