export type AgentErrorCategory = "provider" | "context_overflow" | "tool_failure" | "interrupted";
export interface NormalizedError {
    readonly category: AgentErrorCategory;
    readonly message: string;
    readonly retryable: boolean;
    readonly cause?: unknown;
}
/** Classify one failure; retry execution and recovery remain the runtime's responsibility. */
export declare function normalizeError(err: unknown, ctx?: {
    toolName?: string;
}): NormalizedError;
//# sourceMappingURL=errors.d.ts.map