import type { AgentEvent, ToolCall } from "./types";
import type { AgentErrorCategory, NormalizedError } from "./errors";
import type { AgentToolResult } from "./tool-types";
export declare const AGENT_RUNTIME_EVENT_VERSION = 2;
export interface AgentRuntimeEventEnvelope<T = unknown> {
    readonly v: 2;
    readonly runId: string;
    readonly seq: number;
    readonly ts: number;
    readonly type: string;
    readonly payload: T;
}
export type AgentRuntimeEventPayload = {
    kind: "run_started";
    sessionId: string;
} | {
    kind: "run_resumed";
    sessionId: string;
} | {
    kind: "run_interrupted";
    cause: AgentErrorCategory;
} | {
    kind: "run_awaiting_approval";
    toolCallId: string;
} | {
    kind: "run_completed";
    reason?: "response" | "max_iterations";
    iterations?: number;
} | {
    kind: "run_failed";
    error: NormalizedError;
} | {
    kind: "iteration_start";
    iteration: number;
} | {
    kind: "iteration_end";
    iteration: number;
} | AgentEvent | {
    kind: "tool_result";
    toolCall: ToolCall;
    result: AgentToolResult;
} | {
    kind: "compaction_completed";
    droppedEntries: number;
    summaryDigest: string;
} | {
    kind: "proposal";
    toolCallId: string;
    proposalDigest: string;
    artifactId: string;
} | {
    kind: "role_switch";
    roleId: string;
};
type EventType<P extends AgentRuntimeEventPayload> = P extends {
    kind: infer K extends string;
} ? K : P extends {
    type: infer K extends string;
} ? K : never;
type EnvelopeFor<P extends AgentRuntimeEventPayload> = P extends AgentRuntimeEventPayload ? AgentRuntimeEventEnvelope<P> & {
    readonly type: EventType<P>;
} : never;
export type AgentRuntimeEvent = EnvelopeFor<AgentRuntimeEventPayload>;
/** Unknown v2 types are safe to skip; damaged known events are never silently ignored. */
export declare function parseAgentRuntimeEvent(value: unknown): AgentRuntimeEvent | null;
/** Clock and monotonically increasing sequence are supplied by the runtime owner. */
export declare function createAgentRuntimeEvent<P extends AgentRuntimeEventPayload>(runId: string, seq: number, ts: number, payload: P): Extract<AgentRuntimeEvent, {
    type: EventType<P>;
}>;
export {};
//# sourceMappingURL=events.d.ts.map