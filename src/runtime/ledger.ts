import type { AgentErrorCategory } from "../errors";
import type { TokenUsage } from "../types";
import { cloneJson } from "../store/json";
import { hasOnlyKeys, isCount, isId, isRecord, isTokenUsage } from "../store/validation";

export type ApprovalDecision = "allow" | "deny" | "suspend";

export interface LedgerRecord {
	readonly runId: string;
	readonly seq: number;
	readonly ts: number;
	readonly event:
		| { kind: "model_call"; provider: string; model: string; requestIndex: number; usage: TokenUsage }
		| {
			kind: "tool_intent";
			toolCallId: string;
			tool: string;
			argsDigest: string;
		}
		| {
			kind: "tool_exec";
			toolCallId: string;
			tool: string;
			argsDigest: string;
			outcome: "success" | "failure";
			messageDigest: string;
			artifactId?: string;
			commandId?: string;
			projectRevisionBefore?: number;
			projectRevisionAfter?: number;
		}
		| { kind: "retry"; toolCallId?: string; attempt: number; category: AgentErrorCategory }
		| { kind: "approval"; toolCallId: string; decision: ApprovalDecision }
		| { kind: "terminal"; status: "completed" | "failed" | "interrupted" | "awaiting_approval" }
		| { kind: "compaction" | "cancellation"; detail?: string };
}

export interface RuntimeLedger {
	append(record: LedgerRecord): Promise<void>;
	/** Successful tool executions only; toolCallId is global across runs. */
	hasExecuted(toolCallId: string): Promise<boolean>;
	/** Global replay lookup: successful execution dominates later failures. */
	getToolExecution(toolCallId: string): Promise<LedgerRecord | null>;
	query(runId: string): Promise<LedgerRecord[]>;
}

const eventKeys: Record<string, readonly string[]> = {
	model_call: ["kind", "provider", "model", "requestIndex", "usage"],
	tool_intent: ["kind", "toolCallId", "tool", "argsDigest"],
	tool_exec: [
		"kind", "toolCallId", "tool", "argsDigest", "outcome", "messageDigest",
		"artifactId", "commandId", "projectRevisionBefore", "projectRevisionAfter",
	],
	retry: ["kind", "toolCallId", "attempt", "category"],
	approval: ["kind", "toolCallId", "decision"],
	terminal: ["kind", "status"],
	compaction: ["kind", "detail"],
	cancellation: ["kind", "detail"],
};


const errorCategories: Record<AgentErrorCategory, true> = {
	provider: true,
	context_overflow: true,
	tool_failure: true,
	interrupted: true,
};

export function isLedgerRecord(value: unknown): value is LedgerRecord {
	if (!isRecord(value) || !hasOnlyKeys(value, ["runId", "seq", "ts", "event"])
		|| !["runId", "seq", "ts", "event"].every(key => Object.hasOwn(value, key))
		|| !isId(value.runId) || !isCount(value.seq) || value.seq === 0
		|| typeof value.ts !== "number" || !Number.isFinite(value.ts) || value.ts < 0) return false;
	const event = value.event;
	if (!isRecord(event) || !Object.hasOwn(event, "kind") || typeof event.kind !== "string" || !Object.hasOwn(eventKeys, event.kind)
		|| !hasOnlyKeys(event, eventKeys[event.kind]!)) return false;

	switch (event.kind) {
		case "model_call":
			return ["provider", "model", "requestIndex", "usage"].every(key => Object.hasOwn(event, key))
				&& isId(event.provider) && isId(event.model) && isCount(event.requestIndex)
				&& isTokenUsage(event.usage);
		case "tool_intent":
			return ["toolCallId", "tool", "argsDigest"].every(key => Object.hasOwn(event, key))
				&& isId(event.toolCallId) && isId(event.tool) && isId(event.argsDigest);
		case "tool_exec":
			return ["toolCallId", "tool", "argsDigest", "outcome", "messageDigest"].every(key => Object.hasOwn(event, key))
				&& isId(event.toolCallId) && isId(event.tool) && isId(event.argsDigest)
				&& isId(event.messageDigest) && (event.outcome === "success" || event.outcome === "failure")
				&& ["artifactId", "commandId"].every(key => event[key] === undefined || isId(event[key]))
				&& ["projectRevisionBefore", "projectRevisionAfter"].every(key => event[key] === undefined || isCount(event[key]));
		case "retry":
			return ["attempt", "category"].every(key => Object.hasOwn(event, key))
				&& (event.toolCallId === undefined || isId(event.toolCallId)) && isCount(event.attempt)
				&& typeof event.category === "string" && Object.hasOwn(errorCategories, event.category);
		case "approval":
			return Object.hasOwn(event, "toolCallId") && Object.hasOwn(event, "decision") && isId(event.toolCallId)
				&& (event.decision === "allow" || event.decision === "deny" || event.decision === "suspend");
		case "terminal":
			return event.status === "completed" || event.status === "failed" || event.status === "interrupted" || event.status === "awaiting_approval";
		case "compaction":
		case "cancellation":
			return event.detail === undefined || typeof event.detail === "string";
		default:
			return false;
	}
}

/**
 * Append-only in-memory history. Only allowlisted fields are accepted; supplied
 * digest/detail strings are not inspected for semantic secrets or redacted.
 */
export class InMemoryLedger implements RuntimeLedger {
	private readonly recordsByRun = new Map<string, LedgerRecord[]>();
	private readonly successfulToolCallIds = new Set<string>();
	private readonly successfulExecutions = new Map<string, LedgerRecord>();
	private readonly latestToolRecords = new Map<string, LedgerRecord>();
	private readonly claimedIntents = new Set<string>();

	async append(record: LedgerRecord): Promise<void> {
		if (!isLedgerRecord(record)) throw new TypeError("Invalid ledger record");
		// Validate before cloning so an unknown undefined property cannot disappear.
		const snapshot = cloneJson(record);
		if (!isLedgerRecord(snapshot)) throw new TypeError("Invalid normalized ledger record");
		const records = this.recordsByRun.get(snapshot.runId);
		const previous = records?.at(-1);
		if (previous && snapshot.seq <= previous.seq) {
			throw new Error("Ledger sequence must strictly increase within a run");
		}
		if (snapshot.event.kind === "tool_intent" && this.claimedIntents.has(snapshot.event.toolCallId)) {
			throw new Error("Tool call intent already claimed");
		}
		// No await between validation and commit: failed appends cannot mutate either index.
		if (records) records.push(snapshot);
		else this.recordsByRun.set(snapshot.runId, [snapshot]);
		if (snapshot.event.kind === "tool_intent") {
			this.claimedIntents.add(snapshot.event.toolCallId);
			this.latestToolRecords.set(snapshot.event.toolCallId, snapshot);
		} else if (snapshot.event.kind === "tool_exec") {
			this.latestToolRecords.set(snapshot.event.toolCallId, snapshot);
			if (snapshot.event.outcome === "success") {
				this.successfulToolCallIds.add(snapshot.event.toolCallId);
				this.successfulExecutions.set(snapshot.event.toolCallId, snapshot);
			}
		}
	}

	async hasExecuted(toolCallId: string): Promise<boolean> {
		if (!isId(toolCallId)) throw new TypeError("Invalid tool call id");
		return this.successfulToolCallIds.has(toolCallId);
	}

	async getToolExecution(toolCallId: string): Promise<LedgerRecord | null> {
		if (!isId(toolCallId)) throw new TypeError("Invalid tool call id");
		const record = this.successfulExecutions.get(toolCallId) ?? this.latestToolRecords.get(toolCallId);
		return record ? cloneJson(record) : null;
	}

	async query(runId: string): Promise<LedgerRecord[]> {
		if (!isId(runId)) throw new TypeError("Invalid run id");
		return cloneJson(this.recordsByRun.get(runId) ?? []);
	}
}
