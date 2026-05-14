import type {
	AgentEvent,
	AgentLLMConfig,
	AgentMessage,
	OpenAIMessage,
	ToolCall,
	ToolDefinition,
} from "./types";
import { ExpertRoleRegistry } from "./expert-roles";
import type { PromptLayer } from "./prompt-builder";
import { buildSystemPrompt } from "./prompt-builder";
import { streamChatCompletion } from "./llm-client";

export const SWITCH_ROLE_TOOL_NAME = "switch_expert_role";

export interface RunAgentLoopParams {
	messages: AgentMessage[];
	llmConfig: AgentLLMConfig;
	expertRoleId: string;
	activeRoleId?: string;
	dynamicContext?: string | null;
	ragContext?: string | null;
	identityPrompt?: string;
	workRules?: string;
	tools?: ToolDefinition[];
	customLayers?: PromptLayer[];
	switchRoleToolDef?: ToolDefinition;
	locale?: "zh" | "en";
	signal?: AbortSignal;
}

function buildDefaultSwitchRoleTool(): ToolDefinition {
	const roles = ExpertRoleRegistry.getAll().filter((r) => !r.isOrchestrator);
	const enumValues = roles.map((r) => r.id);
	const descParts = roles.map((r) => `${r.id} (${r.description})`);

	return {
		type: "function",
		function: {
			name: SWITCH_ROLE_TOOL_NAME,
			description:
				"Switch your active expert role to leverage specialized knowledge for the current phase. " +
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

export async function* runAgentLoop(params: RunAgentLoopParams): AsyncGenerator<AgentEvent> {
	const {
		messages,
		llmConfig,
		expertRoleId,
		dynamicContext,
		ragContext,
		identityPrompt,
		workRules,
		tools,
		locale,
		signal,
	} = params;

	const orchestratorRole = ExpertRoleRegistry.get(expertRoleId);
	const isOrchestrator = orchestratorRole?.isOrchestrator ?? false;
	const activeRoleId = params.activeRoleId ?? expertRoleId;

	const expertRolePrompt = ExpertRoleRegistry.getSystemPrompt(
		isOrchestrator ? expertRoleId : activeRoleId,
		locale,
	);

	let activeRolePrompt: string | undefined;
	if (isOrchestrator && activeRoleId !== expertRoleId) {
		const delegatedPrompt = ExpertRoleRegistry.getSystemPrompt(activeRoleId, locale);
		activeRolePrompt =
			delegatedPrompt +
			`\nYou are currently operating as the **${activeRoleId}** expert, delegated by the orchestrator. ` +
			"Focus on this specialty. Use `switch_expert_role` when you need a different expertise.";
	}

	let contextSection: string | undefined;
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

	const openAIMessages: OpenAIMessage[] = [
		{ role: "system", content: systemPrompt },
		...messages
			.filter((m) => m.role !== "system")
			.map((m): OpenAIMessage => {
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
					role: m.role as "user" | "assistant",
					content: m.content,
				};
			}),
	];

	yield { type: "status", status: "thinking" };

	const stream = streamChatCompletion(llmConfig, openAIMessages, signal, allTools);

	let accumulatedToolCalls: ToolCall[] = [];

	for await (const chunk of stream) {
		if (signal?.aborted) return;

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
			case "error":
				yield { type: "error", message: chunk.message };
				return;
		}
	}

	if (accumulatedToolCalls.length > 0) {
		yield { type: "tool_calls_complete", toolCalls: accumulatedToolCalls };
	}
	yield { type: "message_end" };
}
