import type { AgentMessage } from "../types";
import type { ContextSummary, ProjectFactsDigest } from "./context-manager";
export declare function validateContextSummary(value: unknown): ContextSummary;
export declare function parseContextSummary(serialized: string): ContextSummary;
export declare function currentProjectFacts(value?: ProjectFactsDigest): ProjectFactsDigest | undefined;
export declare function summarySystemMessage(summary: ContextSummary): AgentMessage;
export declare function contextSystemMessages(facts?: ProjectFactsDigest, summary?: ContextSummary): AgentMessage[];
export declare function contextSummaryDigest(summary: ContextSummary): string;
//# sourceMappingURL=context-summary.d.ts.map