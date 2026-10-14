import type { AgentMessage, ToolCall } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentCheckpointRef } from "../store/checkpoint";
import type { ToolFailureRecord } from "../session";
import type { ExternalStateBinding } from "../tool-types";
import type { HostSnapshot } from "./context-manager";
import type { RuntimeLedger } from "./ledger";
import type { RuntimeHistory } from "./history";
import type { AgentArtifactStore } from "../store/artifact-store";
import { canonicalJson } from "../store/json";
import { projectMessages } from "./history";
import { computeContextDigest } from "../store/checkpoint";
import { isExternalStateBinding, isToolResult } from "../store/validation";
import type { AgentCheckpoint } from "../store/checkpoint";
import type { LedgerRecord } from "./ledger";
import { SWITCH_ROLE_TOOL_NAME } from "../service";

/** A checkpoint is immutable: only committed, matching execution records can advance its binding. */
export async function verifiedStateBinding(checkpoint: AgentCheckpoint | AgentCheckpointRef, runId: string,
	entries: readonly AgentSessionEntry[], records: readonly LedgerRecord[], artifacts: AgentArtifactStore,
	checkpoints?: readonly AgentCheckpoint[]): Promise<ExternalStateBinding | undefined> {
	const runCheckpoints: readonly AgentCheckpoint[] = checkpoints?.filter(item => item.runId === runId)
		?? ("entrySeq" in checkpoint ? [checkpoint] : []);
	if (!runCheckpoints.length || runCheckpoints.some(item => item.sessionId !== checkpoint.sessionId || item.seq === undefined)) rejectRecovery("Missing run state provenance");
	for (let index = 0; index < runCheckpoints.length; index++) {
		const item = runCheckpoints[index]!;
		if (index > 0 && item.seq! <= runCheckpoints[index - 1]!.seq!) rejectRecovery("Invalid checkpoint sequence order");
		if ("entrySeq" in item && (item.entrySeq > entries.length || computeContextDigest(projectMessages(entries.slice(0, item.entrySeq))) !== item.contextDigest)) rejectRecovery("Earlier checkpoint digest mismatch");
	}
	const first = runCheckpoints[0]!;
	let expected = first.externalStateBinding;
	if (expected !== undefined && !isExternalStateBinding(expected)) rejectRecovery("Invalid checkpoint state binding");
	const calls = new Map<string, ToolCall>();
	for (const entry of entries) if (entry.kind === "assistant_message") {
		for (const call of entry.toolCalls ?? []) {
			if (calls.has(call.id)) rejectRecovery("Duplicate tool call id in state history");
			calls.set(call.id, call);
		}
	}
	const intents = new Set<string>();
	let boundaryIndex = 0;
	let previousSeq = 0;
	for (const record of records) {
		if (record.runId !== runId || record.seq <= previousSeq) rejectRecovery("Invalid run ledger ordering");
		previousSeq = record.seq;
		while (boundaryIndex < runCheckpoints.length && (runCheckpoints[boundaryIndex]!.seq ?? 0) < record.seq) {
			const saved = runCheckpoints[boundaryIndex++]!.externalStateBinding;
			if (saved?.scopeId !== expected?.scopeId || saved?.version !== expected?.version) rejectRecovery("Checkpoint adopted unverified state");
		}
		if (record.event.kind === "tool_intent") intents.add(record.event.toolCallId);
		if (record.event.kind !== "tool_exec") continue;
		const execution = record.event;
		const call = calls.get(execution.toolCallId);
		const digest = call && computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
		if (!call || execution.tool !== call.function.name || execution.argsDigest !== digest || !intents.has(call.id)
			|| !execution.artifactId) rejectRecovery("Unbound committed execution in state chain");
		const artifact = await artifacts.get(execution.artifactId);
		if (!artifact || artifact.sessionId !== checkpoint.sessionId || artifact.contentType !== "application/json"
			|| !isToolResult(artifact.value) || artifact.value.success !== (execution.outcome === "success")) rejectRecovery("Invalid committed execution artifact");
		const bytes = new TextEncoder().encode(canonicalJson(artifact.value.message));
		let hash = 0x811c9dc5;
		for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
		if (hash.toString(16).padStart(8, "0") !== execution.messageDigest) rejectRecovery("Committed execution message digest mismatch");
		const change = execution.receipt?.stateChange;
		if (change) {
			if (!expected || change.before.scopeId !== expected.scopeId || change.before.version !== expected.version
				|| change.after.scopeId !== expected.scopeId) rejectRecovery("Committed execution state chain is discontinuous");
			expected = change.after;
		}
	}
	while (boundaryIndex < runCheckpoints.length) {
		const saved = runCheckpoints[boundaryIndex++]!.externalStateBinding;
		if (saved?.scopeId !== expected?.scopeId || saved?.version !== expected?.version) rejectRecovery("Checkpoint adopted unverified state");
	}
	return expected;
}

export interface ResumeState {
	messages: AgentMessage[];
	userMessage: string;
	seq: number;
	iteration: number;
	phase: "model" | "tools" | "settled";
	activeRoleId: string;
	pendingToolCalls: ToolCall[];
	failures: ToolFailureRecord[];
	checkpoint: AgentCheckpointRef;
}

export function rejectRecovery(message: string): never {
	throw { category: "tool_failure", message, retryable: false };
}

export function assertNewRun(entries: readonly AgentSessionEntry[]): void {
	const start = entries.findLast(entry => entry.kind === "run_started");
	if (!start || start.kind !== "run_started") return;
	if (!entries.some(entry => (entry.kind === "run_completed" || entry.kind === "run_failed") && entry.runId === start.runId)) {
		rejectRecovery("Session has an unfinished run; resume its runId instead of starting a new run");
	}
}

/** Read-only preflight: nothing is appended and no model/tool is invoked on rejection. */
export async function loadResumeState(history: RuntimeHistory, ledger: RuntimeLedger, runId: string,
	getSnapshot: (() => HostSnapshot | undefined) | undefined, artifacts: AgentArtifactStore): Promise<ResumeState> {
	const entries = await history.entries();
	const startIndex = entries.findIndex(entry => entry.kind === "run_started" && entry.runId === runId);
	if (startIndex < 0) rejectRecovery("Unknown runId");
	const head = entries.findLast(entry => entry.kind === "run_started");
	if (head?.kind !== "run_started" || head.runId !== runId) rejectRecovery("Cannot resume a stale run behind the session head");
	if (entries.some(entry => (entry.kind === "run_completed" || entry.kind === "run_failed") && entry.runId === runId)) {
		rejectRecovery("Cannot resume a completed or failed run");
	}
	const cursor = entries.findLast(entry => entry.kind === "run_state" && entry.runId === runId);
	if (!cursor || cursor.kind !== "run_state") rejectRecovery("Run has no durable recovery cursor");
	const records = await ledger.query(runId);
	if (records.some(record => record.event.kind === "terminal" && (record.event.status === "completed" || record.event.status === "failed"))) rejectRecovery("Cannot resume a terminal ledger run");
	const checkpoints = await history.checkpoints();
	const referenced = checkpoints.find(checkpoint => checkpoint.checkpointId === cursor.checkpointId);
	if (!referenced || referenced.sessionId !== history.sessionId || (referenced.runId !== undefined && referenced.runId !== runId)) rejectRecovery("Recovery cursor references an invalid checkpoint");
	const boundary = checkpoints.findLast(checkpoint => checkpoint.runId === runId) ?? checkpoints.find(checkpoint => checkpoint.checkpointId === cursor.checkpointId);
	if (!boundary || boundary.sessionId !== history.sessionId || boundary.entrySeq > entries.length) rejectRecovery("Run has no valid checkpoint boundary");
	if (boundary.runId !== undefined && boundary.runId !== runId) rejectRecovery("Checkpoint belongs to another run");
	const messages = projectMessages(entries);
	if (computeContextDigest(projectMessages(entries.slice(0, boundary.entrySeq))) !== boundary.contextDigest) rejectRecovery("Checkpoint context digest mismatch");
	if (computeContextDigest(messages) !== boundary.contextDigest) {
		// A confirmed message may commit just before its checkpoint transaction.
		let assistantCount = 0;
		for (const entry of entries.slice(boundary.entrySeq)) {
			if (entry.kind === "user_message") rejectRecovery("Checkpoint context digest mismatch");
			if (entry.kind === "assistant_message" && (cursor.phase !== "model" || ++assistantCount > 1)) rejectRecovery("Checkpoint has an invalid assistant suffix");
			if (entry.kind !== "tool_result") continue;
			const call = messages.flatMap(message => message.toolCalls ?? []).find(candidate => candidate.id === entry.toolCallId);
			if (!call) rejectRecovery("Checkpoint has an unmatched result suffix");
			if (call.function.name === SWITCH_ROLE_TOOL_NAME) {
				let role = cursor.activeRoleId;
				try { role = JSON.parse(call.function.arguments).role ?? role; } catch { /* Legacy role fallback. */ }
				if (canonicalJson(entry.result) !== canonicalJson({ success: true, message: `Switched to ${role}` })) rejectRecovery("Checkpoint role result mismatch");
				continue;
			}
			const execution = await ledger.getToolExecution(entry.toolCallId);
			if (!execution && entry.artifactId === undefined && canonicalJson(entry.result) === canonicalJson({ success: false, message: "approval_denied" })) {
				const decision = records.findLast(record => record.event.kind === "approval" && record.event.toolCallId === call.id);
				const request = entries.findLast(item => item.kind === "approval_requested" && item.toolCallId === call.id);
				const resolution = entries.findLast(item => item.kind === "approval_resolved" && item.toolCallId === call.id);
				const bound = request?.kind !== "approval_requested" || (request.runId === runId && request.argsDigest === computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }])
					&& resolution?.kind === "approval_resolved" && resolution.runId === runId && resolution.decision === "deny" && resolution.proposalDigest === request.proposalDigest);
				if (bound && decision?.event.kind === "approval" && decision.event.decision === "deny") continue;
			}
			if (execution?.event.kind !== "tool_exec" || !execution.event.artifactId) rejectRecovery("Checkpoint result has no committed execution");
			const artifact = await artifacts.get(execution.event.artifactId);
			if (!artifact || artifact.sessionId !== history.sessionId || canonicalJson(artifact.value) !== canonicalJson(entry.result)) rejectRecovery("Checkpoint result artifact mismatch");
		}
	}
	const expectedBinding = await verifiedStateBinding(boundary, runId, entries, records, artifacts, checkpoints);
	const observed = getSnapshot?.()?.externalStateBinding;
	if (expectedBinding?.scopeId !== observed?.scopeId || expectedBinding?.version !== observed?.version) rejectRecovery("Checkpoint external state binding mismatch");

	const pending = new Map<string, ToolCall>();
	let batch: ToolCall[] = [];
	const results = new Map<string, AgentMessage>();
	for (const message of messages) {
		if (message.role === "tool") {
			if (!message.toolCallId || !pending.delete(message.toolCallId)) rejectRecovery("Session has an unmatched tool result");
			results.set(message.toolCallId, message);
		} else {
			if (pending.size) rejectRecovery("Session has a non-final unfinished tool batch");
			if (message.role === "assistant") batch = message.toolCalls ?? [];
			for (const call of message.toolCalls ?? []) {
				if (pending.has(call.id)) rejectRecovery("Session has duplicate tool-call IDs");
				pending.set(call.id, call);
			}
		}
	}
	let activeRoleId = cursor.activeRoleId;
	const failures: ToolFailureRecord[] = [];
	for (const call of batch) {
		const resultMessage = results.get(call.id);
		if (!resultMessage) continue;
		const result = JSON.parse(resultMessage.content);
		if (!result.success) failures.push({ toolName: call.function.name, errorMessage: result.message });
		if (call.function.name === SWITCH_ROLE_TOOL_NAME && result.success) {
			try { activeRoleId = JSON.parse(call.function.arguments).role ?? activeRoleId; }
			catch { /* Confirmed legacy role switches retain the saved role. */ }
		}
	}
	let phase = cursor.phase;
	let iteration = cursor.iteration;
	if (pending.size) phase = "tools";
	else if (phase === "tools") { phase = "model"; iteration++; }
	const runMessages = projectMessages(entries.slice(startIndex));
	const lastAssistant = runMessages.findLast(message => message.role === "assistant");
	if (lastAssistant && !lastAssistant.toolCalls?.length) phase = "settled";
	else if (phase === "settled") phase = "model";
	let seq = cursor.seq;
	for (const entry of entries) if (entry.kind === "run_state" && entry.runId === runId) seq = Math.max(seq, entry.seq);
	for (const record of records) seq = Math.max(seq, record.seq);
	for (const checkpoint of checkpoints) if (checkpoint.runId === runId) seq = Math.max(seq, checkpoint.seq ?? 0);
	return { messages, userMessage: runMessages.find(message => message.role === "user")?.content ?? "",
		seq,
		iteration, phase, activeRoleId, pendingToolCalls: [...pending.values()], failures,
		checkpoint: { checkpointId: boundary.checkpointId, sessionId: boundary.sessionId, contextDigest: boundary.contextDigest,
			...(expectedBinding === undefined ? {} : { externalStateBinding: expectedBinding }) } };
}
