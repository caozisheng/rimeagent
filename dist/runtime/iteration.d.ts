import type { AgentMessage, ToolCall } from "../types";
import type { AgentRuntimeEventPayload } from "../events";
import type { AgentSessionConfig, AgentSessionParams, ToolFailureRecord } from "../session";
export interface IterationOutcome {
    reason: "response" | "max_iterations" | "error" | "interrupted";
    iterations: number;
    errorMessage?: string;
}
export type IterationStream = AsyncGenerator<AgentRuntimeEventPayload, IterationOutcome>;
export interface IterationHooks {
    beforeIteration?: (failures: ToolFailureRecord[], iteration: number) => {
        dynamicContext?: string | null;
        ragContext?: string | null;
    };
    onMessage?: (message: AgentMessage) => Promise<void>;
    onToolStart?: (toolCall: ToolCall) => Promise<void>;
    /** Internal compatibility policy: deliver callback values before JSON history conversion. */
    legacyToolResults?: boolean;
}
/** The single iteration engine; its owner supplies persistence and lifecycle events. */
export declare function runSessionIterations(params: AgentSessionParams, config: AgentSessionConfig, hooks?: IterationHooks): IterationStream;
//# sourceMappingURL=iteration.d.ts.map