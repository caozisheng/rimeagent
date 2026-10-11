import type { NormalizedError } from "../errors";
import type { AgentToolResult } from "../tool-types";
import type { TokenUsage, ToolCall } from "../types";
import type { ProjectFactsDigest } from "../runtime/context-manager";
import type { AgentSessionEntry } from "./entries";
type RecordValue = Record<string, unknown>;
export declare function isRecord(value: unknown): value is RecordValue;
export declare function hasOnlyKeys(record: RecordValue, keys: readonly string[]): boolean;
export declare function isId(value: unknown): value is string;
export declare function isCount(value: unknown): value is number;
export declare function isToolCall(value: unknown): value is ToolCall;
/** Validates dense own elements without invoking caller-controlled array methods. */
export declare function isToolCalls(value: unknown): value is ToolCall[];
export declare function isTokenUsage(value: unknown): value is TokenUsage;
export declare function isToolResult(value: unknown): value is AgentToolResult;
export declare function isNormalizedError(value: unknown): value is NormalizedError;
export declare function isProjectFacts(value: unknown): value is ProjectFactsDigest;
export declare function isAgentSessionEntry(value: unknown): value is AgentSessionEntry;
export {};
//# sourceMappingURL=validation.d.ts.map