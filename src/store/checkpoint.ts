import type { AgentMessage } from "../types";
import { canonicalJson } from "./json";
import { isId, isRecord, isToolCalls } from "./validation";

export interface AgentCheckpoint {
	readonly checkpointId: string;
	readonly sessionId: string;
	readonly parentId?: string;
	readonly createdAt: number;
	readonly entrySeq: number;
	readonly contextDigest: string;
	readonly label?: string;
	readonly runId?: string;
	readonly seq?: number;
	readonly projectId?: string;
	readonly projectRevision?: number;
	readonly projectCheckpointId?: string;
}

export interface AgentCheckpointRef {
	readonly checkpointId: string;
	readonly sessionId: string;
	readonly projectId?: string;
	readonly projectRevision?: number;
	readonly projectCheckpointId?: string;
	readonly contextDigest: string;
}

/** References an agent history branch, never a project restore operation. */
export interface AgentBranch {
	readonly branchId: string;
	readonly sessionId: string;
	readonly fromCheckpointId: string;
}

const MODEL_ROLES: Record<string, true> = { user: true, assistant: true, system: true, tool: true };

/** Stable model-visible UTF-8 FNV-1a32 digest; not a security integrity hash. */
export function computeContextDigest(messages: readonly AgentMessage[]): string {
	if (!Array.isArray(messages) || Object.getPrototypeOf(messages) !== Array.prototype) throw new TypeError("Context messages must be a plain array");
	const length = Object.getOwnPropertyDescriptor(messages, "length")?.value;
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) throw new TypeError("Invalid context array boundary");
	const projection: Record<string, unknown>[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
		if (!descriptor || !("value" in descriptor)) throw new TypeError("Context messages must contain only data elements");
		const message: unknown = descriptor.value;
		if (!isRecord(message) || !Object.hasOwn(message, "role") || !Object.hasOwn(message, "content")
			|| typeof message.role !== "string" || !Object.hasOwn(MODEL_ROLES, message.role)
			|| typeof message.content !== "string") {
			throw new TypeError("Invalid model-visible message");
		}
		const visible: Record<string, unknown> = { role: message.role, content: message.content };
		if (Object.hasOwn(message, "toolCalls") && message.toolCalls !== undefined) {
			const calls = message.toolCalls;
			if (!isToolCalls(calls)) {
				throw new TypeError("Invalid model-visible tool calls");
			}
			visible.toolCalls = calls;
		}
		if (Object.hasOwn(message, "toolCallId") && message.toolCallId !== undefined) {
			if (!isId(message.toolCallId)) throw new TypeError("Invalid model-visible tool call id");
			visible.toolCallId = message.toolCallId;
		}
		projection.push(visible);
	}
	const bytes = new TextEncoder().encode(canonicalJson(projection));
	let hash = 0x811c9dc5;
	for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	return hash.toString(16).padStart(8, "0");
}
