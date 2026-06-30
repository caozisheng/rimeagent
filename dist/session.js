import { runAgentLoop, SWITCH_ROLE_TOOL_NAME } from "./service";
export async function* runAgentSession(params, config) {
    let { llmConfig } = params;
    let activeRoleId = params.activeRoleId ?? params.expertRoleId;
    let allMessages = [...params.messages];
    let lastIterationFailures = [];
    for (let iteration = 0; iteration < config.maxIterations; iteration++) {
        if (params.signal?.aborted)
            return;
        yield { type: "iteration_start", iteration };
        let ragContext = params.ragContext ?? undefined;
        if (lastIterationFailures.length > 0 && config.onIterationFailures) {
            const recovery = config.onIterationFailures(lastIterationFailures);
            if (recovery) {
                ragContext = ragContext ? ragContext + "\n\n" + recovery : recovery;
            }
        }
        const stream = runAgentLoop({
            ...params,
            messages: allMessages,
            llmConfig,
            activeRoleId,
            ragContext: ragContext ?? null,
        });
        let pendingToolCalls = [];
        let assistantContent = "";
        for await (const event of stream) {
            if (params.signal?.aborted)
                return;
            switch (event.type) {
                case "text_delta":
                    assistantContent += event.content;
                    yield event;
                    break;
                case "tool_calls_complete":
                    pendingToolCalls = event.toolCalls;
                    yield event;
                    break;
                case "message_end": {
                    yield event;
                    if (pendingToolCalls.length === 0)
                        return;
                    const assistantMsg = {
                        id: `assistant-${Date.now()}-${iteration}`,
                        role: "assistant",
                        content: assistantContent,
                        toolCalls: pendingToolCalls,
                        createdAt: Date.now(),
                    };
                    allMessages = [...allMessages, assistantMsg];
                    const failures = [];
                    for (const tc of pendingToolCalls) {
                        if (tc.function.name === SWITCH_ROLE_TOOL_NAME) {
                            let args = {};
                            try {
                                args = JSON.parse(tc.function.arguments);
                            }
                            catch { /* skip */ }
                            const newRoleId = args.role ?? activeRoleId;
                            activeRoleId = newRoleId;
                            if (config.onRoleSwitch) {
                                const newConfig = config.onRoleSwitch(newRoleId);
                                if (newConfig)
                                    llmConfig = newConfig;
                            }
                            yield { type: "role_switch", roleId: newRoleId };
                            const toolMsg = {
                                id: `tool-${tc.id}`,
                                role: "tool",
                                content: JSON.stringify({ success: true, message: `Switched to ${newRoleId}` }),
                                toolCallId: tc.id,
                                createdAt: Date.now(),
                            };
                            allMessages = [...allMessages, toolMsg];
                            continue;
                        }
                        const result = await config.onToolCall(tc);
                        yield { type: "tool_result", toolCall: tc, result };
                        if (!result.success) {
                            failures.push({
                                toolName: tc.function.name,
                                errorMessage: result.message,
                            });
                        }
                        const toolMsg = {
                            id: `tool-${tc.id}`,
                            role: "tool",
                            content: JSON.stringify(result),
                            toolCallId: tc.id,
                            createdAt: Date.now(),
                        };
                        allMessages = [...allMessages, toolMsg];
                    }
                    lastIterationFailures = failures;
                    assistantContent = "";
                    pendingToolCalls = [];
                    break;
                }
                case "error":
                    yield event;
                    return;
                default:
                    yield event;
                    break;
            }
        }
    }
}
//# sourceMappingURL=session.js.map