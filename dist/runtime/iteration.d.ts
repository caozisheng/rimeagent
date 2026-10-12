import type { AgentMessage, ToolCall, TokenUsage } from "../types";
import type { AgentRuntimeEventPayload } from "../events";
import type { AgentSessionConfig, AgentSessionParams, ToolFailureRecord } from "../session";
import type { AgentToolResult } from "../tool-types";
import type { PreparedAgentRequest, RunAgentLoopParams } from "../service";
import type { NormalizedError } from "../errors";
export interface IterationOutcome {
    reason: "response" | "max_iterations" | "error" | "interrupted" | "awaiting_approval";
    iterations: number;
    errorMessage?: string;
    error?: NormalizedError;
}
export type IterationStream = AsyncGenerator<AgentRuntimeEventPayload, IterationOutcome>;
export interface InitialIterationState {
    iterationOffset: number;
    pendingToolCalls?: readonly ToolCall[];
    failures?: readonly ToolFailureRecord[];
}
export interface IterationContext {
    dynamicContext?: string | null;
    ragContext?: string | null;
}
export interface IterationRequestInput {
    params: RunAgentLoopParams;
    iteration: number;
    attempt: number;
    failures: readonly ToolFailureRecord[];
}
export interface PreparedIterationRequest extends PreparedAgentRequest {
    events?: AgentRuntimeEventPayload[];
}
export interface IterationHooks {
    beforeIteration?: (failures: ToolFailureRecord[], iteration: number) => IterationContext | Promise<IterationContext>;
    beforeRequest?: (input: IterationRequestInput) => PreparedIterationRequest | Promise<PreparedIterationRequest>;
    onContextOverflow?: (error: NormalizedError, attempt: number) => boolean | Promise<boolean>;
    onPreparationError?: (cause: unknown) => void;
    onMessage?: (message: AgentMessage, usage?: TokenUsage) => Promise<void>;
    onToolStart?: (toolCall: ToolCall) => Promise<void>;
    beforeToolBatch?: (calls: readonly ToolCall[]) => Promise<readonly AgentRuntimeEventPayload[] | undefined>;
    parallelTool?: (call: ToolCall) => boolean;
    onToolBatch?: (calls: readonly ToolCall[]) => Promise<readonly AgentToolResult[]>;
    initialState?: InitialIterationState;
    /** Internal compatibility policy: deliver callbacks before JSON history conversion. */
    legacyToolResults?: boolean;
}
/** The single iteration engine, including replay of an already confirmed tool batch. */
export declare function runSessionIterations(params: AgentSessionParams, config: AgentSessionConfig, hooks?: IterationHooks): IterationStream;
//# sourceMappingURL=iteration.d.ts.map