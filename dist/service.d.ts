import type { AgentEvent, AgentLLMConfig, AgentMessage, ToolDefinition } from "./types";
import type { PromptLayer } from "./prompt-builder";
export declare const SWITCH_ROLE_TOOL_NAME = "switch_expert_role";
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
export declare function runAgentLoop(params: RunAgentLoopParams): AsyncGenerator<AgentEvent>;
//# sourceMappingURL=service.d.ts.map