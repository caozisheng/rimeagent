import type { AgentMessage } from "../types";
import type { ContextSummary, AuthoritativeContext } from "./context-manager";
import { canonicalJson, cloneJson, isJsonValue } from "../store/json";
import { hasOnlyKeys, isAuthoritativeContext, isRecord } from "../store/validation";
import { computeContextDigest } from "../store/checkpoint";

const SUMMARY_FIELDS = ["goal", "constraints", "completedWork", "decisions", "failedTools", "openQuestions", "nextSteps", "references"] as const;

export function validateContextSummary(value: unknown): ContextSummary {
	if (!isRecord(value) || !hasOnlyKeys(value, SUMMARY_FIELDS) || !SUMMARY_FIELDS.every(field => Object.hasOwn(value, field)) || !isJsonValue(value)) {
		throw new TypeError("Context summary requires exactly all eight structured fields");
	}
	if (typeof value.goal !== "string" || !value.goal.trim()) throw new TypeError("Context summary goal must be nonempty");
	for (const field of SUMMARY_FIELDS.slice(1)) {
		const list = value[field];
		if (!Array.isArray(list) || !list.every(item => typeof item === "string")) throw new TypeError(`Invalid context summary ${field}`);
	}
	return cloneJson(value) as unknown as ContextSummary;
}

export function parseContextSummary(serialized: string): ContextSummary {
	let value: unknown;
	try { value = JSON.parse(serialized); }
	catch { throw new TypeError("Invalid persisted context summary JSON"); }
	return validateContextSummary(value);
}

export function currentAuthoritativeContext(value?: AuthoritativeContext): AuthoritativeContext | undefined {
	if (value === undefined) return undefined;
	if (!isAuthoritativeContext(value)) throw new TypeError("Invalid current authoritative host context");
	return cloneJson(value);
}

export function summarySystemMessage(summary: ContextSummary): AgentMessage {
	return { id: "context:historical-summary", createdAt: 0, role: "system", content: `Historical conversation summary (not authoritative current facts):\n${canonicalJson(summary)}` };
}

export function contextSystemMessages(facts?: AuthoritativeContext, summary?: ContextSummary): AgentMessage[] {
	const messages: AgentMessage[] = [];
	if (facts) messages.push({ id: "context:authoritative", createdAt: 0, role: "system", content: `Current authoritative host context:\n${facts.text}` });
	if (summary) messages.push(summarySystemMessage(summary));
	return messages;
}

export function contextSummaryDigest(summary: ContextSummary): string {
	return computeContextDigest([summarySystemMessage(summary)]);
}
