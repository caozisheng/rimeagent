import { nanoid } from "nanoid";
import type { AgentMessage } from "../types";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentCheckpoint, AgentCheckpointRef } from "../store/checkpoint";
import { computeContextDigest } from "../store/checkpoint";
import { isToolResult } from "../store/validation";
import { normalizeError } from "../errors";
import type { ProjectFactsDigest } from "./context-manager";

type EntryBody = AgentSessionEntry extends infer E ? E extends AgentSessionEntry ? Omit<E, "id" | "ts"> : never : never;

export function projectMessages(entries: readonly AgentSessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		const base = { id: entry.id, createdAt: entry.ts };
		switch (entry.kind) {
			case "user_message": messages.push({ ...base, role: "user", content: entry.content }); break;
			case "assistant_message": messages.push({ ...base, role: "assistant", content: entry.content,
				...(entry.toolCalls === undefined ? {} : { toolCalls: entry.toolCalls }) }); break;
			case "tool_result": messages.push({ ...base, role: "tool", toolCallId: entry.toolCallId, content: JSON.stringify(entry.result) }); break;
		}
	}
	return messages;
}

/** New runs require a complete protocol; resume repairs the final pending batch. */
export function assertCompleteHistory(messages: readonly AgentMessage[]): void {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "tool") {
			if (!message.toolCallId || !pending.delete(message.toolCallId)) {
				throw normalizeError(new Error("Session has an unmatched tool result"), { toolName: "history" });
			}
			continue;
		}
		if (pending.size) throw normalizeError(new Error("Session has an unfinished tool batch; resume the existing run"), { toolName: "history" });
		for (const call of message.toolCalls ?? []) {
			if (pending.has(call.id)) throw normalizeError(new Error("Session has duplicate tool-call IDs"), { toolName: "history" });
			pending.add(call.id);
		}
	}
	if (pending.size) throw normalizeError(new Error("Session has an unfinished tool batch; resume the existing run"), { toolName: "history" });
}

export interface HistoryBoundary {
	runId: string;
	seq: number;
	projectFacts?: ProjectFactsDigest;
}

/** Appends confirmed messages only; lifecycle/checkpoints never enter the model projection. */
export class RuntimeHistory {
	private parentId: string | undefined;
	persistenceFailures = 0;

	constructor(private readonly store: AgentSessionStore, readonly sessionId: string) {}

	private async access<T>(operation: () => Promise<T>): Promise<T> {
		try { return await operation(); }
		catch (cause) { this.persistenceFailures++; throw cause; }
	}

	async append(body: EntryBody): Promise<void> {
		await this.access(() => this.store.append(this.sessionId, { ...body, id: nanoid(), ts: Date.now() } as AgentSessionEntry));
	}

	async recordMessage(message: AgentMessage, artifactId?: string): Promise<void> {
		if (message.role === "user") {
			await this.append({ kind: "user_message", content: message.content });
		} else if (message.role === "assistant") {
			await this.append({ kind: "assistant_message", content: message.content,
				...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }) });
		} else if (message.role === "tool") {
			const result: unknown = JSON.parse(message.content);
			if (!message.toolCallId || !isToolResult(result)) throw new TypeError("Initial tool messages require a serialized AgentToolResult and toolCallId");
			await this.append({ kind: "tool_result", toolCallId: message.toolCallId, result,
				...(artifactId === undefined ? {} : { artifactId }) });
		}
	}

	async entries(): Promise<AgentSessionEntry[]> {
		return (await this.access(() => this.store.load(this.sessionId)))?.entries ?? [];
	}

	async checkpoints(): Promise<AgentCheckpoint[]> {
		return this.access(() => this.store.listCheckpoints(this.sessionId));
	}

	async load(initialMessages?: readonly AgentMessage[]): Promise<AgentMessage[]> {
		let snapshot = await this.access(() => this.store.load(this.sessionId));
		if (!snapshot && initialMessages) {
			for (const message of initialMessages) await this.recordMessage(message);
			snapshot = await this.access(() => this.store.load(this.sessionId));
		}
		return projectMessages(snapshot?.entries ?? []);
	}

	async checkpoint(label?: string, boundary?: HistoryBoundary): Promise<AgentCheckpointRef> {
		if (label !== undefined && typeof label !== "string") throw new TypeError("Checkpoint label must be a string");
		const snapshot = await this.access(() => this.store.load(this.sessionId));
		if (this.parentId === undefined) {
			this.parentId = (await this.access(() => this.store.listCheckpoints(this.sessionId))).at(-1)?.checkpointId;
		}
		const checkpointId = nanoid();
		const contextDigest = computeContextDigest(projectMessages(snapshot?.entries ?? []));
		await this.access(() => this.store.saveCheckpoint({ checkpointId, sessionId: this.sessionId, createdAt: Date.now(),
			entrySeq: snapshot?.entries.length ?? 0, contextDigest,
			...(this.parentId === undefined ? {} : { parentId: this.parentId }),
			...(boundary === undefined ? {} : { runId: boundary.runId, seq: boundary.seq }),
			...(boundary?.projectFacts === undefined ? {} : {
				projectRevision: boundary.projectFacts.projectRevision,
				...(boundary.projectFacts.projectId === undefined ? {} : { projectId: boundary.projectFacts.projectId }),
			}),
			...(label === undefined ? {} : { label }) }));
		await this.append({ kind: "checkpoint", checkpointId });
		this.parentId = checkpointId;
		return { checkpointId, sessionId: this.sessionId, contextDigest,
			...(boundary?.projectFacts === undefined ? {} : { projectRevision: boundary.projectFacts.projectRevision,
				...(boundary.projectFacts.projectId === undefined ? {} : { projectId: boundary.projectFacts.projectId }) }) };
	}
}
