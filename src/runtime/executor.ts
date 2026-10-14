import { nanoid } from "nanoid";
import type { ToolCall } from "../types";
import type { DurableAgentTool, AgentToolResult, ExecutionReceipt, ExternalStateBinding } from "../tool-types";
import { normalizeError } from "../errors";
import { computeContextDigest } from "../store/checkpoint";
import { canonicalJson, cloneJson } from "../store/json";
import type { JsonValue } from "../store/json";
import { isId, isRecord, isToolCall, isToolResult, isExecutionReceipt, isExternalStateBinding, hasOnlyKeys } from "../store/validation";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { LedgerRecord, RuntimeLedger } from "./ledger";
import type { HostSnapshot } from "./context-manager";
import { validateProposalDecision } from "./approval";
import type { ApprovalGate, PreflightDecision } from "./approval";
const textEncoder = new TextEncoder();
export interface ToolExecutorContext {
	readonly runId: string;
	readonly nextSeq: () => number;
	readonly signal?: AbortSignal;
	/** A coherent current host snapshot, including the external state binding. */
	readonly getHostSnapshot?: () => HostSnapshot | undefined;
	/** Bound run's latest verified state. Missing snapshots fail closed. */
	readonly expectedBinding?: () => Promise<ExternalStateBinding | undefined>;
	/** Advances the active run only after a validated execution and ledger commit. */
	readonly onCommittedStateChange?: (after: ExternalStateBinding) => void;
	/** Durable, call-specific decisions validated by the runtime before execution. */
	readonly approvalDecisions?: Readonly<Record<string, "allow" | "deny">>;
	/** Marks adapter failures during preflight without changing the original exception. */
	readonly onPersistenceFailure?: () => void;
}

export interface ToolExecutor {
	execute(call: ToolCall, context: ToolExecutorContext): Promise<AgentToolResult>;
	preflight(call: ToolCall, context: ToolExecutorContext): Promise<PreflightDecision>;
	executeBatch(calls: readonly ToolCall[], context: ToolExecutorContext): Promise<AgentToolResult[]>;
}

/** Scheduler policy. Read-only parallelism is opt-in to preserve phase 4 ordering. */
export interface ToolExecutorConfig {
	readonly parallelReadOnly?: boolean;
}
export interface ToolExecutorOptions {
	readonly sessionId: string;
	readonly tools: readonly DurableAgentTool[];
	readonly ledger: RuntimeLedger;
	readonly artifactStore: AgentArtifactStore;
	readonly approval?: ApprovalGate;
	readonly executor?: ToolExecutorConfig;
}

const TOOL_RESULT_CONTENT_TYPE = "application/json";

function failure(message: string): AgentToolResult {
	return { success: false, message };
}

function digest(value: unknown): string {
	const bytes = textEncoder.encode(canonicalJson(value));
	let hash = 0x811c9dc5;
	for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	return hash.toString(16).padStart(8, "0");
}

function argsDigest(call: ToolCall): string {
	return computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
}

function parseArguments(call: ToolCall): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(call.function.arguments);
		if (!isRecord(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function validateExecution(value: unknown): { result: AgentToolResult; receipt?: ExecutionReceipt } {
	if (!isRecord(value) || !hasOnlyKeys(value, ["result", "receipt"]) || !isToolResult(value.result)
		|| Object.hasOwn(value.result, "undoable") || (value.receipt !== undefined && !isExecutionReceipt(value.receipt))) {
		throw new TypeError("Tool returned an invalid durable execution");
	}
	return { result: value.result, ...(value.receipt === undefined ? {} : { receipt: value.receipt }) };
}

function sameBinding(before: ExternalStateBinding | undefined, after: ExternalStateBinding | undefined): boolean {
	return before?.scopeId === after?.scopeId && before?.version === after?.version;
}

function replayError(message: string, toolName: string): never {
	throw normalizeError(new Error(message), { toolName });
}

export class ApprovalRequiredError extends Error {
	readonly toolCall: ToolCall;
	readonly decision: Extract<PreflightDecision, { action: "suspend" }>;

	constructor(toolCall: ToolCall, decision: Extract<PreflightDecision, { action: "suspend" }>) {
		super(decision.reason);
		this.name = "ApprovalRequiredError";
		this.toolCall = toolCall;
		this.decision = decision;
	}
}
export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
	if (!isId(options.sessionId)) throw new TypeError("Invalid session id");
	const tools = new Map<string, DurableAgentTool>();
	for (const tool of options.tools) tools.set(tool.name, tool);
	let tail = Promise.resolve();

	const preflight = async (call: ToolCall, context: ToolExecutorContext): Promise<PreflightDecision> => {
		if (isToolCall(call)) {
			let completed: LedgerRecord | null;
			try { completed = await options.ledger.getToolExecution(call.id); }
			catch (cause) { context.onPersistenceFailure?.(); throw cause; }
			if (completed && (completed.runId !== context.runId || ((completed.event.kind === "tool_intent" || completed.event.kind === "tool_exec")
				&& (completed.event.tool !== call.function.name || completed.event.argsDigest !== argsDigest(call))))) replayError("Tool call id was reused with different run or arguments", call.function.name);
			if (completed?.event.kind === "tool_exec") {
				// Policy controls new effects, never rewrites an already committed outcome.
				return { action: "allow" };
			}
		}
		const persisted = context.approvalDecisions?.[call.id];
		if (persisted === "allow") return { action: "allow" };
		if (persisted === "deny") return { action: "deny" };
		if (!options.approval) {
			const annotations = tools.get(call.function.name)?.annotations;
			return annotations?.requiresApproval || annotations?.destructive ? { action: "suspend", reason: "Tool requires approval" } : { action: "allow" };
		}
		const binding = context.getHostSnapshot?.()?.externalStateBinding;
		if (binding !== undefined && !isExternalStateBinding(binding)) throw new TypeError("Invalid host state binding");
		return validateProposalDecision(await options.approval.preflight({
			runId: context.runId,
			toolCall: call,
			...(tools.get(call.function.name)?.annotations === undefined ? {} : { annotations: tools.get(call.function.name)!.annotations }),
			...(binding === undefined ? {} : { externalStateBinding: binding }),
		}));
	};

	const readCachedResult = async (record: LedgerRecord): Promise<AgentToolResult> => {
		if (record.event.kind !== "tool_exec" || !record.event.artifactId) {
			throw new Error("Tool execution has no cached artifact");
		}
		const artifact = await options.artifactStore.get(record.event.artifactId);
		if (!artifact || !isRecord(artifact) || artifact.artifactId !== record.event.artifactId || artifact.sessionId !== options.sessionId || artifact.contentType !== TOOL_RESULT_CONTENT_TYPE
			|| !isToolResult(artifact.value)) {
			throw new Error("Missing or corrupt cached tool result artifact");
		}
		if ((record.event.outcome === "success") !== artifact.value.success || digest(artifact.value.message) !== record.event.messageDigest) {
			throw new Error("Cached tool result does not match ledger");
		}
		return cloneJson(artifact.value);
	};

	const executeOne = async (call: ToolCall, context: ToolExecutorContext, approvalAllowed: boolean): Promise<AgentToolResult> => {
		if (context.signal?.aborted) return failure("Operation was aborted");
		if (!isToolCall(call) || !isId(context.runId)) return failure("Invalid tool call");
		const parsed = parseArguments(call);
		if (!parsed) return failure("Invalid JSON arguments");
		const tool = tools.get(call.function.name);
		const callArgsDigest = argsDigest(call);
		const expected = await context.expectedBinding?.();
		const prior = await options.ledger.getToolExecution(call.id);
		if (prior) {
			if (prior.runId !== context.runId) replayError("Tool call id belongs to another run", call.function.name);
			if (prior.event.kind !== "tool_intent" && prior.event.kind !== "tool_exec") throw new Error("Invalid tool replay record");
			if (prior.event.tool !== call.function.name || prior.event.argsDigest !== callArgsDigest) {
				replayError("Tool call id was reused with different arguments", call.function.name);
			}
			if (prior.event.kind === "tool_exec") return readCachedResult(prior);
			const annotations = tool?.annotations;
			if (!tool || tool.requiresConfirmation || ((tool.annotations?.requiresApproval || tool.annotations?.destructive) && !approvalAllowed)) {
				return failure("Tool requires approval");
			}
			if (!(annotations?.readOnly || annotations?.idempotent)) {
				replayError("Tool call has an uncertain external effect", call.function.name);
			}
			const priorRun = await options.ledger.query(context.runId);
			let attempts = 0;
			for (const item of priorRun) if (item.event.kind === "retry" && item.event.toolCallId === call.id) attempts++;
			await options.ledger.append({ runId: context.runId, seq: context.nextSeq(), ts: Date.now(), event: { kind: "retry", toolCallId: call.id, attempt: attempts + 1, category: "tool_failure" } });
		} else {
			if (!tool) return failure(`Unknown tool: ${call.function.name}`);
			if (tool.requiresConfirmation || ((tool.annotations?.requiresApproval || tool.annotations?.destructive) && !approvalAllowed)) {
				return failure("Tool requires approval");
			}
			// A losing concurrent writer keeps the durable claim error. It must not guess
			// whether the winning writer has already performed its external side effect.
			await options.ledger.append({ runId: context.runId, seq: context.nextSeq(), ts: Date.now(), event: { kind: "tool_intent", toolCallId: call.id, tool: call.function.name, argsDigest: callArgsDigest } });
		}

		const observed = context.getHostSnapshot?.()?.externalStateBinding;
		if (!sameBinding(expected, observed)) replayError("External state changed before tool execution", call.function.name);
		let raw: unknown;
		try {
			raw = await tool!.execute(parsed);
		} catch (cause) {
			// An uncertain non-idempotent effect is not a normal tool failure.
			if (!tool?.annotations?.readOnly && !tool?.annotations?.idempotent) throw cause;
			const error = normalizeError(cause, { toolName: call.function.name });
			raw = { result: failure(error.message) };
		}
		const { result, receipt } = validateExecution(raw);
		// No validation/persistence fault after a committed effect can be mistaken for a tool failure.
		const change = receipt?.stateChange;
		if (change && (!expected || !sameBinding(change.before, expected) || change.after.scopeId !== expected.scopeId)) {
			throw new TypeError("Tool receipt does not continue the external state binding");
		}
		const latest = context.getHostSnapshot?.()?.externalStateBinding;
		if (!sameBinding(change?.after ?? expected, latest)) throw new Error("Host state does not match the committed tool receipt");
		const artifactId = nanoid();
		await options.artifactStore.put({ artifactId, sessionId: options.sessionId, contentType: TOOL_RESULT_CONTENT_TYPE, value: cloneJson(result) as unknown as JsonValue });
		const event: LedgerRecord["event"] = {
			kind: "tool_exec", toolCallId: call.id, tool: call.function.name, argsDigest: callArgsDigest,
			outcome: result.success ? "success" : "failure", messageDigest: digest(result.message), artifactId,
			...(receipt === undefined ? {} : { receipt }),
		};
		await options.ledger.append({ runId: context.runId, seq: context.nextSeq(), ts: Date.now(), event });
		if (change) context.onCommittedStateChange?.(change.after);
		return cloneJson(result);
	};

	const executeBatch = async (calls: readonly ToolCall[], context: ToolExecutorContext): Promise<AgentToolResult[]> => {
		const decisions = await Promise.all(calls.map(call => preflight(call, context)));
		for (let index = 0; index < calls.length; index++) {
			const decision = decisions[index]!;
			if (decision.action === "suspend") throw new ApprovalRequiredError(calls[index]!, decision);
		}
		const results = new Array<AgentToolResult>(calls.length);
		const approvalAllowed = (index: number) => decisions[index]!.action === "allow" && (options.approval !== undefined || context.approvalDecisions?.[calls[index]!.id] === "allow");
		const isParallelRead = (call: ToolCall) => {
			const annotations = tools.get(call.function.name)?.annotations;
			return options.executor?.parallelReadOnly === true
				&& annotations?.readOnly === true && annotations.executionMode === "parallel";
		};
		for (let index = 0; index < calls.length;) {
			if (context.signal?.aborted) return results.slice(0, index);
			if (decisions[index]!.action === "deny") {
				results[index++] = failure("approval_denied");
				continue;
			}
			if (!isParallelRead(calls[index]!)) {
				results[index] = await executeOne(calls[index]!, context, approvalAllowed(index));
				index++;
				continue;
			}
			const group: number[] = [];
			const ids = new Set<string>();
			while (index < calls.length && decisions[index]!.action === "allow" && isParallelRead(calls[index]!) && !ids.has(calls[index]!.id)) {
				group.push(index); ids.add(calls[index]!.id); index++;
			}
			const settled = await Promise.allSettled(group.map(item => executeOne(calls[item]!, context, approvalAllowed(item))));
			const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
			if (rejected) throw rejected.reason;
			for (let item = 0; item < group.length; item++) results[group[item]!] = (settled[item] as PromiseFulfilledResult<AgentToolResult>).value;
			if (context.signal?.aborted) return results.slice(0, index);
		}
		return results;
	};

	const schedule = (calls: readonly ToolCall[], context: ToolExecutorContext): Promise<AgentToolResult[]> => {
		const result = tail.then(() => executeBatch(calls, context));
		tail = result.then(() => undefined, () => undefined);
		return result;
	};

	return {
		preflight,
		executeBatch: schedule,
		async execute(call, context) {
			const results = await schedule([call], context);
			return results[0] ?? failure("Operation was aborted");
		},
	};
}
