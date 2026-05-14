import type { PromptLayer } from "./prompt-builder";
import type { AgentTool } from "./tool-types";

export interface SkillKnowledgeEntry {
	id: string;
	name: string;
	triggers: string[];
	sections: {
		quickStart: string;
		patterns: { title: string; code: string }[];
		gotchas: string[];
		apiQuickRef: string[];
	};
	relatedSkills: string[];
}

export interface AgentSkillWithKnowledge {
	id: string;
	name: string;
	description: string;
	tools?: AgentTool[];
	promptLayers?: PromptLayer[];
	knowledge?: SkillKnowledgeEntry;
	onActivate?: () => void | Promise<void>;
	onDeactivate?: () => void | Promise<void>;
}
