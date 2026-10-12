import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { ContextBudget, ContextManagerConfig } from "./context-manager";
export declare function throwIfContextAborted(signal?: AbortSignal): void;
export declare function validateContextConfig(config: ContextManagerConfig): void;
export declare function contextBudget(config: ContextManagerConfig, llmConfig: AgentLLMConfig): ContextBudget;
export declare function createTokenCounter(config: ContextManagerConfig): (text: string) => number;
/** Count provider-visible fields only; persistence metadata cannot spend the model window. */
export declare function serializeContextRequest(systemPrompt: string, messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): string;
//# sourceMappingURL=context-budget.d.ts.map