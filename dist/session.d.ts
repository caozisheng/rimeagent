import type { AgentEvent, AgentLLMConfig, AgentMessage, ToolCall, ToolDefinition } from "./types";
import type { AgentToolResult } from "./tool-types";
import type { PromptLayer } from "./prompt-builder";
export interface ToolFailureRecord {
    toolName: string;
    errorMessage: string;
}
export interface AgentSessionConfig {
    /** Maximum tool-call iterations before the session stops. */
    maxIterations: number;
    /** Execute a tool call and return the result. */
    onToolCall: (toolCall: ToolCall) => Promise<AgentToolResult>;
    /** Called when the LLM requests a role switch (orchestrator mode). Return updated llmConfig if the new role uses a different model. */
    onRoleSwitch?: (roleId: string) => AgentLLMConfig | void;
    /** Called with failures from the previous iteration, return optional recovery context to inject into ragContext. */
    onIterationFailures?: (failures: ToolFailureRecord[]) => string | undefined;
}
export interface AgentSessionParams {
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
export type AgentSessionEvent = AgentEvent | {
    type: "tool_result";
    toolCall: ToolCall;
    result: AgentToolResult;
} | {
    type: "role_switch";
    roleId: string;
} | {
    type: "iteration_start";
    iteration: number;
};
export declare function runAgentSession(params: AgentSessionParams, config: AgentSessionConfig): AsyncGenerator<AgentSessionEvent>;
//# sourceMappingURL=session.d.ts.map