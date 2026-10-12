import { computeContextDigest } from "../store/checkpoint";
import { canonicalJson, cloneJson, isJsonValue } from "../store/json";
import { hasOnlyKeys, isRecord } from "../store/validation";
function ownValue(record, key) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor
        ? { present: true, value: descriptor.value }
        : { present: false };
}
/**
 * Computes the proposal binding required for suspended approval decisions. This is
 * a stable context digest, not a cryptographic integrity hash.
 */
export function computeProposalDigest(proposal) {
    return computeContextDigest([{
            id: "proposal",
            createdAt: 0,
            role: "assistant",
            content: canonicalJson(proposal),
        }]);
}
function invalidProposalDecision() {
    throw new TypeError("Invalid approval preflight decision");
}
/**
 * Validates untrusted gate output before the parent runtime persists or acts on it.
 * It returns a frozen sanitized decision; proposals are cloned after their canonical
 * digest has been verified.
 */
export function validateProposalDecision(decision) {
    try {
        if (!isRecord(decision))
            return invalidProposalDecision();
        const action = ownValue(decision, "action");
        if (!action.present || typeof action.value !== "string")
            return invalidProposalDecision();
        if (action.value === "allow") {
            if (!hasOnlyKeys(decision, ["action"]))
                return invalidProposalDecision();
            return Object.freeze({ action: "allow" });
        }
        if (action.value === "deny") {
            const reason = ownValue(decision, "reason");
            if (!hasOnlyKeys(decision, ["action", "reason"])
                || (reason.present && reason.value !== undefined && typeof reason.value !== "string"))
                return invalidProposalDecision();
            return reason.present && typeof reason.value === "string"
                ? Object.freeze({ action: "deny", reason: reason.value })
                : Object.freeze({ action: "deny" });
        }
        if (action.value !== "suspend" || !hasOnlyKeys(decision, ["action", "reason", "proposal", "proposalDigest"]))
            return invalidProposalDecision();
        const reason = ownValue(decision, "reason");
        if (!reason.present || typeof reason.value !== "string" || reason.value.trim().length === 0)
            return invalidProposalDecision();
        const proposal = ownValue(decision, "proposal");
        const proposalDigest = ownValue(decision, "proposalDigest");
        if (proposal.present !== proposalDigest.present)
            return invalidProposalDecision();
        if (!proposal.present || !proposalDigest.present)
            return Object.freeze({ action: "suspend", reason: reason.value });
        const proposalValue = proposal.value;
        const digest = proposalDigest.value;
        if (!isJsonValue(proposalValue) || typeof digest !== "string" || digest.length === 0 || computeProposalDigest(proposalValue) !== digest)
            return invalidProposalDecision();
        return Object.freeze({ action: "suspend", reason: reason.value, proposal: cloneJson(proposalValue), proposalDigest: digest });
    }
    catch {
        return invalidProposalDecision();
    }
}
function suspendedDecision(context) {
    const name = context.toolCall.function.name;
    const annotations = context.annotations;
    const reason = annotations?.destructive
        ? `Tool ${JSON.stringify(name)} is marked destructive and requires approval.`
        : `Tool ${JSON.stringify(name)} is marked as requiring approval.`;
    return Object.freeze({ action: "suspend", reason });
}
/**
 * Creates the intentionally boring built-in policy: ordinary and read-only calls
 * proceed, while tools explicitly marked destructive or approval-required pause.
 * It creates no proposal and holds no approval decision state.
 */
export function createDefaultApprovalGate(options = {}) {
    const allow = Object.freeze({ action: "allow" });
    return Object.freeze({
        preflight(context) {
            if (context.annotations?.destructive || context.annotations?.requiresApproval)
                return suspendedDecision(context);
            return allow;
        },
        async resolve(toolCallId, decision, note) {
            await options.onResolved?.(toolCallId, decision, note);
        },
    });
}
//# sourceMappingURL=approval.js.map