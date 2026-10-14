import type { AgentMessage } from "../types";
import type { ContextSummary, AuthoritativeContext } from "./context-manager";
export declare function validateContextSummary(value: unknown): ContextSummary;
export declare function parseContextSummary(serialized: string): ContextSummary;
export declare function currentAuthoritativeContext(value?: AuthoritativeContext): AuthoritativeContext | undefined;
export declare function summarySystemMessage(summary: ContextSummary): AgentMessage;
export declare function contextSystemMessages(facts?: AuthoritativeContext, summary?: ContextSummary): AgentMessage[];
export declare function contextSummaryDigest(summary: ContextSummary): string;
//# sourceMappingURL=context-summary.d.ts.map