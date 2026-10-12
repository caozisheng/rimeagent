import { nanoid } from "nanoid";
import type { AgentLLMConfig, AgentMessage, ToolDefinition } from "../types";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { AgentSessionEntry } from "../store/entries";
import { canonicalJson, cloneJson } from "../store/json";
import { isId } from "../store/validation";
import { normalizeError } from "../errors";
import { contextBudget, createTokenCounter, serializeContextRequest, throwIfContextAborted, validateContextConfig } from "./context-budget";
import { chooseContextCut, loadContextHistory } from "./context-history";
import { contextSummaryDigest, contextSystemMessages, currentProjectFacts, summarySystemMessage, validateContextSummary } from "./context-summary";
import { prepareContextMessages } from "./context-tools";

/** Model input budgeting is separate from immutable persisted conversation history. */
export interface ContextManagerConfig {
	readonly tokenizer?: (text: string) => number;
	readonly contextTokens?: number;
	readonly reserveOutputTokens?: number;
	readonly compactTriggerRatio?: number;
	readonly maxToolResultTokens?: number;
}

/** Only a current host snapshot can supply authoritative project facts. */
export interface ProjectFactsDigest {
	readonly projectId?: string;
	readonly projectRevision: number;
	readonly digest: string;
	readonly summary?: string;
	readonly producedBy: "host";
}

export interface ContextProjection {
	readonly messages: AgentMessage[];
	readonly tokensUsed: number;
	readonly compacted: boolean;
	readonly compaction?: { readonly droppedEntries: number; readonly summaryDigest: string };
}

export interface ContextSummary {
	readonly goal: string;
	readonly constraints: string[];
	readonly completedEdits: string[];
	readonly decisions: string[];
	readonly failedTools: string[];
	readonly openQuestions: string[];
	readonly nextSteps: string[];
	readonly references: string[];
}

export interface SummarizeContextInput {
	readonly previousSummary?: ContextSummary;
	readonly messages: readonly AgentMessage[];
	readonly projectFacts: ProjectFactsDigest;
	readonly signal?: AbortSignal;
}

export type ContextSummarizer = (input: SummarizeContextInput) => ContextSummary | Promise<ContextSummary>;

export interface ContextBudget {
	readonly contextTokens: number;
	readonly reserveOutputTokens: number;
	readonly inputTokens: number;
	readonly triggerTokens: number;
}

export interface ContextProjectInput {
	readonly llmConfig: AgentLLMConfig;
	readonly systemPrompt: string;
	readonly tools: readonly ToolDefinition[];
	readonly projectFacts?: ProjectFactsDigest;
	readonly forceCompact?: boolean;
	readonly signal?: AbortSignal;
}

export interface ContextManagerOptions {
	readonly sessionId: string;
	readonly sessionStore: AgentSessionStore;
	readonly artifactStore: AgentArtifactStore;
	readonly config?: ContextManagerConfig;
	readonly summarize?: ContextSummarizer;
}

export interface ContextManager {
	project(input: ContextProjectInput): Promise<ContextProjection>;
	countTokens(text: string): number;
	getBudget(llmConfig: AgentLLMConfig): ContextBudget;
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
	if (!isId(options.sessionId)) throw new TypeError("Invalid context session id");
	const config = { ...options.config };
	validateContextConfig(config);
	const countTokens = createTokenCounter(config);
	const getBudget = (llmConfig: AgentLLMConfig): ContextBudget => contextBudget(config, llmConfig);
	// One manager cannot race its own append-only compaction or artifact commits.
	let tail = Promise.resolve();
	const project = async (input: ContextProjectInput): Promise<ContextProjection> => {
		throwIfContextAborted(input.signal);
		const budget = getBudget(input.llmConfig);
		const facts = currentProjectFacts(input.projectFacts);
		const snapshot = await options.sessionStore.load(options.sessionId);
		throwIfContextAborted(input.signal);
		if (snapshot && snapshot.sessionId !== options.sessionId) throw new TypeError("Context snapshot belongs to another session");
		const history = loadContextHistory(snapshot?.entries ?? []);
		const activeIds = new Set(history.messages.slice(history.compactedCount).map(message => message.id));
		const prepared = await prepareContextMessages(history.entries.filter(entry => activeIds.has(entry.id)), {
			sessionId: options.sessionId, artifactStore: options.artifactStore,
			maxTokens: config.maxToolResultTokens ?? 2048, countTokens, signal: input.signal,
		});
		let summary = history.previousSummary;
		if (summary && countTokens(summarySystemMessage(summary).content) > budget.inputTokens) throw new TypeError("Persisted context summary exceeds the input token budget");
		let messages = [...contextSystemMessages(facts, summary), ...prepared.messages];
		let tokensUsed = countTokens(serializeContextRequest(input.systemPrompt, messages, input.tools));
		let compaction: AgentSessionEntry | undefined;
		let droppedEntries = 0;
		if (options.summarize && facts && (input.forceCompact || tokensUsed >= budget.triggerTokens)) {
			const checkpoints = await options.sessionStore.listCheckpoints(options.sessionId);
			throwIfContextAborted(input.signal);
			const cut = chooseContextCut(history, checkpoints, options.sessionId);
			droppedEntries = cut - history.compactedCount;
			if (droppedEntries > 0) {
				let result: ContextSummary;
				try {
					result = await options.summarize({
						...(summary === undefined ? {} : { previousSummary: cloneJson(summary) }),
						messages: cloneJson(prepared.messages.slice(0, droppedEntries)), projectFacts: cloneJson(facts),
						...(input.signal === undefined ? {} : { signal: input.signal }),
					});
				} catch (cause) {
					throwIfContextAborted(input.signal);
					throw normalizeError(cause);
				}
				throwIfContextAborted(input.signal);
				summary = validateContextSummary(result);
				if (countTokens(summarySystemMessage(summary).content) > budget.inputTokens) throw new TypeError("Context summary exceeds the input token budget");
				messages = [...contextSystemMessages(facts, summary), ...prepared.messages.slice(droppedEntries)];
				tokensUsed = countTokens(serializeContextRequest(input.systemPrompt, messages, input.tools));
				compaction = { id: nanoid(), ts: Date.now(), kind: "compaction", summary: canonicalJson(summary),
					compactedEntryIds: history.messages.slice(0, cut).map(message => message.id), projectDigest: facts };
			}
		}
		for (const artifact of prepared.artifacts) {
			throwIfContextAborted(input.signal);
			await options.artifactStore.put(artifact);
		}
		throwIfContextAborted(input.signal);
		if (compaction) await options.sessionStore.append(options.sessionId, compaction);
		return { messages, tokensUsed, compacted: compaction !== undefined,
			...(compaction && summary ? { compaction: { droppedEntries, summaryDigest: contextSummaryDigest(summary) } } : {}) };
	};
	return { countTokens, getBudget, project(input) {
		const result = tail.then(() => project(input));
		tail = result.then(() => undefined, () => undefined);
		return result;
	} };
}
