import { expect, test } from "bun:test";
import { canonicalJson } from "../../src/store/json";
import { computeContextDigest } from "../../src/store/checkpoint";
import {
	computeProposalDigest,
	createDefaultApprovalGate,
	validateProposalDecision,
	type ToolCallContext,
} from "../../src/runtime/approval";

const context = (annotations?: ToolCallContext["annotations"]): ToolCallContext => ({
	runId: "approval-run",
	toolCall: {
		id: "approval-call",
		type: "function",
		function: { name: "write_file", arguments: '{"path":"note.txt"}' },
	},
	annotations,
	projectId: "project-a",
	projectRevision: 7,
});

function digestFor(proposal: unknown): string {
	return computeContextDigest([{
		id: "proposal",
		createdAt: 0,
		role: "assistant",
		content: canonicalJson(proposal),
	}]);
}

test("the default policy autoallows read-only and ordinary writes", async () => {
	const gate = createDefaultApprovalGate();

	expect(await gate.preflight(context({ readOnly: true }))).toEqual({ action: "allow" });
	expect(await gate.preflight(context())).toEqual({ action: "allow" });
});

test("the default policy suspends destructive and approval-marked calls without inventing a proposal", async () => {
	const gate = createDefaultApprovalGate();

	for (const annotations of [{ destructive: true }, { requiresApproval: true }] as const) {
		const decision = await gate.preflight(context(annotations));
		expect(decision.action).toBe("suspend");
		if (decision.action !== "suspend") throw new Error("Expected suspended decision");
		expect(decision.reason.trim().length).toBeGreaterThan(0);
		expect("proposal" in decision).toBe(false);
		expect("proposalDigest" in decision).toBe(false);
	}
});

test("legacy confirmation is not translated into a default gate suspension", async () => {
	const gate = createDefaultApprovalGate();
	const legacyOnly = {
		...context(),
		toolCall: { ...context().toolCall, requiresConfirmation: true },
	} as unknown as ToolCallContext;

	expect(await gate.preflight(legacyOnly)).toEqual({ action: "allow" });
});

test("proposal decisions require a canonical matching digest and return a sanitized copy", () => {
	const proposal = { files: [{ path: "note.txt", content: "hello" }], mode: "replace" };
	const digest = digestFor(proposal);
	const validated = validateProposalDecision({ action: "suspend", reason: "Review file replacement", proposal, proposalDigest: digest });

	expect(computeProposalDigest(proposal)).toBe(digest);
	expect(validated).toEqual({ action: "suspend", reason: "Review file replacement", proposal, proposalDigest: digest });
	expect(Object.isFrozen(validated)).toBe(true);
	if (validated.action !== "suspend" || validated.proposal === undefined) throw new Error("Expected validated proposal");
	expect(validated.proposal).not.toBe(proposal);
	proposal.mode = "mutated after validation";
	expect(validated.proposal).toEqual({ files: [{ path: "note.txt", content: "hello" }], mode: "replace" });
	expect(() => validateProposalDecision({ action: "suspend", reason: "Review file replacement", proposal })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "suspend", reason: "Review file replacement", proposalDigest: digest })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "suspend", reason: "Review file replacement", proposal, proposalDigest: "wrong" })).toThrow(TypeError);
});

test("proposal digests are stable across equivalent object property orders", () => {
	const first = { z: [{ b: 2, a: 1 }], a: "value" };
	const reordered = { a: "value", z: [{ a: 1, b: 2 }] };
	const digest = digestFor(first);

	expect(canonicalJson(first)).toBe(canonicalJson(reordered));
	expect(computeProposalDigest(reordered)).toBe(digest);
	expect(validateProposalDecision({ action: "suspend", reason: "Review proposal", proposal: reordered, proposalDigest: digest })).toEqual({
		action: "suspend", reason: "Review proposal", proposal: reordered, proposalDigest: digest,
	});
});

test("the validator rejects malformed decisions and accepts strict JSON proposals without an approval-size cap", () => {
	const oversizedProposal = { content: "x".repeat(256 * 1024) };
	const oversizedDigest = digestFor(oversizedProposal);

	expect(() => validateProposalDecision({ action: "suspend", reason: "" })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "suspend", reason: "   " })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "deny", reason: 42 })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "allow", reason: "unexpected" })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "unknown" })).toThrow(TypeError);
	expect(() => validateProposalDecision({ action: "suspend", reason: "Review", proposal: { invalid: () => undefined }, proposalDigest: "ignored" })).toThrow(TypeError);
	expect(validateProposalDecision({ action: "suspend", reason: "Review oversized proposal", proposal: oversizedProposal, proposalDigest: oversizedDigest })).toEqual({
		action: "suspend", reason: "Review oversized proposal", proposal: oversizedProposal, proposalDigest: oversizedDigest,
	});
});

