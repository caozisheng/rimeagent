import type { AgentMessage } from "../types";

/** Frozen configuration contract; the projection engine is implemented in Phase 5. */
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
}
