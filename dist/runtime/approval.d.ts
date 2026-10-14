import type { AgentToolAnnotations } from "../tool-types";
import type { ToolCall } from "../types";
import type { ExternalStateBinding } from "../tool-types";
import { type JsonValue } from "../store/json";
/** A gate outcome before a tool call can have any effect. */
export type PreflightDecision = Readonly<{
    action: "allow";
}> | Readonly<{
    action: "deny";
    reason?: string;
}> | Readonly<{
    action: "suspend";
    reason: string;
    proposal?: JsonValue;
    proposalDigest?: string;
}>;
export type ApprovalResolution = "allow" | "deny";
/** The durable binding data a host needs when evaluating a single tool call. */
export interface ToolCallContext {
    readonly runId: string;
    readonly toolCall: ToolCall;
    readonly annotations?: AgentToolAnnotations;
    readonly externalStateBinding?: ExternalStateBinding;
}
/**
 * Approval policies only advise the runtime. The runtime persists a decision before
 * calling resolve, then resolve may notify a host that has its own durable state.
 */
export interface ApprovalGate {
    preflight(context: ToolCallContext): PreflightDecision | Promise<PreflightDecision>;
    resolve?(toolCallId: string, decision: ApprovalResolution, note?: string): Promise<void>;
}
export interface DefaultApprovalGateOptions {
    readonly onResolved?: (toolCallId: string, decision: ApprovalResolution, note?: string) => void | Promise<void>;
}
/**
 * Computes the proposal binding required for suspended approval decisions. This is
 * a stable context digest, not a cryptographic integrity hash.
 */
export declare function computeProposalDigest(proposal: JsonValue): string;
/**
 * Validates untrusted gate output before the parent runtime persists or acts on it.
 * It returns a frozen sanitized decision; proposals are cloned after their canonical
 * digest has been verified.
 */
export declare function validateProposalDecision(decision: unknown): PreflightDecision;
/**
 * Creates the intentionally boring built-in policy: ordinary and read-only calls
 * proceed, while tools explicitly marked destructive or approval-required pause.
 * It creates no proposal and holds no approval decision state.
 */
export declare function createDefaultApprovalGate(options?: DefaultApprovalGateOptions): ApprovalGate;
//# sourceMappingURL=approval.d.ts.map