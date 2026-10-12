import { ExpertRoleRegistry } from "./expert-roles";
import { buildSystemPrompt } from "./prompt-builder";
import { getLLMBackend, streamChatCompletion } from "./llm-client";
import { normalizeError } from "./errors";
export const SWITCH_ROLE_TOOL_NAME = "switch_expert_role";
function buildDefaultSwitchRoleTool() {
    const roles = ExpertRoleRegistry.getAll().filter((r) => !r.isOrchestrator);
    const enumValues = roles.map((r) => r.id);
    const descParts = roles.map((r) => `${r.id} (${r.description})`);
    return {
        type: "function",
        function: {
            name: SWITCH_ROLE_TOOL_NAME,
            description: "Switch your active expert role to leverage specialized knowledge for the current phase. " +
                "Only available in orchestrator mode.",
            parameters: {
                type: "object",
                properties: {
                    role: {
                        type: "string",
                        enum: enumValues,
                        description: `The expert role to switch to: ${descParts.join(", ")}`,
                    },
                },
                required: ["role"],
            },
        },
    };
}
export function prepareAgentRequest(params) {
    const { messages, llmConfig, expertRoleId, dynamicContext, ragContext, identityPrompt, workRules, tools, locale, } = params;
    const orchestratorRole = ExpertRoleRegistry.get(expertRoleId);
    const isOrchestrator = orchestratorRole?.isOrchestrator ?? false;
    const activeRoleId = params.activeRoleId ?? expertRoleId;
    const expertRolePrompt = ExpertRoleRegistry.getSystemPrompt(isOrchestrator ? expertRoleId : activeRoleId, locale);
    let activeRolePrompt;
    if (isOrchestrator && activeRoleId !== expertRoleId) {
        const delegatedPrompt = ExpertRoleRegistry.getSystemPrompt(activeRoleId, locale);
        activeRolePrompt =
            delegatedPrompt +
                `\nYou are currently operating as the **${activeRoleId}** expert, delegated by the orchestrator. ` +
                "Focus on this specialty. Use `switch_expert_role` when you need a different expertise.";
    }
    let contextSection;
    if (dynamicContext) {
        contextSection =
            "Below is the current state of the host application. Use this to give specific, contextual advice.\n\n" +
                dynamicContext;
    }
    const systemPrompt = buildSystemPrompt({
        identity: identityPrompt,
        expertRole: expertRolePrompt,
        activeRole: activeRolePrompt,
        dynamicContext: contextSection,
        ragContext: ragContext ?? undefined,
        workRules,
        customLayers: params.customLayers,
    });
    const switchRoleDef = isOrchestrator
        ? (params.switchRoleToolDef ?? buildDefaultSwitchRoleTool())
        : undefined;
    const allTools = switchRoleDef
        ? [...(tools ?? []), switchRoleDef]
        : (tools ?? []);
    const openAIMessages = [
        { role: "system", content: systemPrompt },
        ...messages
            .filter((m) => m.role !== "system")
            .map((m) => {
            if (m.role === "assistant" && m.toolCalls?.length) {
                return {
                    role: "assistant",
                    content: m.content || null,
                    tool_calls: m.toolCalls,
                };
            }
            if (m.role === "tool") {
                return {
                    role: "tool",
                    content: m.content,
                    tool_call_id: m.toolCallId,
                };
            }
            return {
                role: m.role,
                content: m.content,
            };
        }),
    ];
    return { llmConfig, messages: openAIMessages, tools: allTools };
}
/** Internal single streaming loop; opaque provider causes never leave this boundary. */
export async function* runPreparedAgentLoop(request, signal) {
    yield { type: "status", status: "thinking" };
    const stream = request.outputTokens === undefined || request.outputTokens === request.llmConfig.maxOutputTokens
        ? streamChatCompletion(request.llmConfig, request.messages, signal, request.tools)
        : getLLMBackend(request.llmConfig).streamChat({ ...request.llmConfig, maxOutputTokens: request.outputTokens }, request.messages, signal, request.tools);
    let accumulatedToolCalls = [];
    for await (const chunk of stream) {
        if (signal?.aborted)
            return;
        switch (chunk.type) {
            case "content_delta":
                yield { type: "text_delta", content: chunk.delta };
                break;
            case "tool_calls_complete":
                accumulatedToolCalls = chunk.toolCalls;
                yield { type: "tool_calls_complete", toolCalls: chunk.toolCalls };
                break;
            case "done":
                yield { type: "message_end", usage: chunk.usage };
                return;
            case "error": {
                const { category, message, retryable } = normalizeError(chunk.error ?? chunk.message);
                yield { type: "error", message: chunk.message, error: { category, message, retryable } };
                return;
            }
        }
    }
    if (accumulatedToolCalls.length > 0) {
        yield { type: "tool_calls_complete", toolCalls: accumulatedToolCalls };
    }
    yield { type: "message_end" };
}
/** Public compatibility wrapper keeps the original event shape exactly. */
export async function* runAgentLoop(params) {
    for await (const event of runPreparedAgentLoop(prepareAgentRequest(params), params.signal)) {
        yield event.type === "error" ? { type: "error", message: event.message } : event;
    }
}
//# sourceMappingURL=service.js.map