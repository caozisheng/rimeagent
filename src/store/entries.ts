import type { AgentErrorCategory, NormalizedError } from "../errors";
import type { AgentToolResult } from "../tool-types";
import type { ExternalStateBinding } from "../tool-types";
import type { TokenUsage, ToolCall } from "../types";
import type { AuthoritativeContext } from "../runtime/context-manager";
import { cloneJson } from "./json";
import { isAgentSessionEntry } from "./validation";
export { isAgentSessionEntry };

export type AgentSessionEntry =
	| { kind: "user_message"; id: string; ts: number; content: string }
	| { kind: "assistant_message"; id: string; ts: number; content: string; toolCalls?: ToolCall[]; usage?: TokenUsage }
	| { kind: "tool_call"; id: string; ts: number; toolCallId: string; name: string; argsDigest: string }
	| { kind: "tool_result"; id: string; ts: number; toolCallId: string; result: AgentToolResult; artifactId?: string; legacyResult?: true } // migrated result JSON stays intact for checkpoint digests
	| { kind: "approval_requested"; id: string; ts: number; toolCallId: string; reason: string; runId?: string; argsDigest?: string; externalStateBinding?: ExternalStateBinding; proposalDigest?: string; artifactId?: string }
	| { kind: "approval_resolved"; id: string; ts: number; toolCallId: string; decision: "allow" | "deny"; by: "user" | "policy"; runId?: string; note?: string; proposalDigest?: string }
	| { kind: "proposal"; id: string; ts: number; toolCallId: string; proposalDigest: string; artifactId: string }
	| { kind: "compaction"; id: string; ts: number; summary: string; compactedEntryIds: string[]; authoritativeContext?: AuthoritativeContext }
	| { kind: "checkpoint"; id: string; ts: number; checkpointId: string }
	| { kind: "branch"; id: string; ts: number; fromCheckpointId: string; branchId: string }
	| { kind: "run_started"; id: string; ts: number; runId: string; parentRunId?: string }
	| { kind: "run_interrupted"; id: string; ts: number; runId: string; cause: AgentErrorCategory; lastDurableBoundary?: string }
	| { kind: "run_awaiting_approval"; id: string; ts: number; runId: string; toolCallId: string }
	| { kind: "run_completed"; id: string; ts: number; runId: string; reason?: "response" | "max_iterations"; iterations?: number }
	| { kind: "run_failed"; id: string; ts: number; runId: string; error: NormalizedError }
	| { kind: "error"; id: string; ts: number; error: NormalizedError }
	| { kind: "usage"; id: string; ts: number; runId: string; usage: TokenUsage }
	| { kind: "run_state"; id: string; ts: number; runId: string; seq: number; iteration: number;
		phase: "model" | "tools" | "settled"; activeRoleId: string; checkpointId?: string };

export interface AgentSessionSnapshot {
	readonly sessionId: string;
	readonly entries: AgentSessionEntry[];
}

function withoutOpaqueCause(entry: AgentSessionEntry): Record<string, unknown> {
	const source = entry as unknown as Record<string, unknown>;
	const kind = Object.getOwnPropertyDescriptor(source, "kind")!.value;
	const result: Record<string, unknown> = {};
	for (const key of Reflect.ownKeys(source)) {
		if (typeof key !== "string") throw new TypeError("Session entry contains a symbol key");
		if ((kind === "error" || kind === "run_failed") && key === "error") continue;
		Object.defineProperty(result, key, { value: Object.getOwnPropertyDescriptor(source, key)!.value,
			enumerable: true, writable: true, configurable: true });
	}
	if (kind === "error" || kind === "run_failed") {
		const error = Object.getOwnPropertyDescriptor(source, "error")!.value as NormalizedError;
		result.error = {
			category: Object.getOwnPropertyDescriptor(error, "category")!.value,
			message: Object.getOwnPropertyDescriptor(error, "message")!.value,
			retryable: Object.getOwnPropertyDescriptor(error, "retryable")!.value,
		};
	}
	return result;
}

export function serializeAgentSessionEntry(entry: AgentSessionEntry): string {
	if (!isAgentSessionEntry(entry)) throw new TypeError("Invalid session entry");
	const snapshot = cloneJson(withoutOpaqueCause(entry));
	if (!isAgentSessionEntry(snapshot)) throw new TypeError("Invalid normalized session entry");
	if ((snapshot.kind === "error" || snapshot.kind === "run_failed") && Object.hasOwn(snapshot.error, "cause")) {
		throw new TypeError("Opaque error cause is not permitted in serialized entries");
	}
	return JSON.stringify(snapshot);
}

export function parseAgentSessionEntry(json: string): AgentSessionEntry {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new TypeError("Invalid session entry JSON");
	}
	if (!isAgentSessionEntry(value)) throw new TypeError("Invalid persisted session entry");
	if (value.kind === "error" || value.kind === "run_failed") {
		const error = value.error as unknown as Record<string, unknown>;
		if (Object.hasOwn(error, "cause")) throw new TypeError("Opaque error cause is not permitted in persisted entries");
	}
	return cloneJson(value);
}
