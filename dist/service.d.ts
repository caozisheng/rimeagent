import type { AgentEvent, AgentLLMConfig, AgentMessage, OpenAIMessage, ToolDefinition } from "./types";
import type { PromptLayer } from "./prompt-builder";
import type { NormalizedError } from "./errors";
export interface PreparedAgentRequest {
    llmConfig: AgentLLMConfig;
    messages: OpenAIMessage[];
    tools: ToolDefinition[];
    /** Runtime budget override; routing still evaluates the original host config. */
    outputTokens?: number;
}
export type PreparedAgentEvent = Exclude<AgentEvent, {
    type: "error";
}> | {
    type: "error";
    message: string;
    error: NormalizedError;
};
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
export declare function prepareAgentRequest(params: RunAgentLoopParams): PreparedAgentRequest;
/** Internal single streaming loop; opaque provider causes never leave this boundary. */
export declare function runPreparedAgentLoop(request: PreparedAgentRequest, signal?: AbortSignal): AsyncGenerator<PreparedAgentEvent>;
/** Public compatibility wrapper keeps the original event shape exactly. */
export declare function runAgentLoop(params: RunAgentLoopParams): AsyncGenerator<AgentEvent>;
//# sourceMappingURL=service.d.ts.map