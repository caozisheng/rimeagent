import type { AgentTool } from "./tool-types";
import type { PromptLayer } from "./prompt-builder";

export interface AgentSkill {
	id: string;
	name: string;
	description: string;
	/** Tool names this skill semantically owns (declared, not registered here). */
	toolRefs?: string[];
	tools?: AgentTool[];
	promptLayers?: PromptLayer[];
	onActivate?: () => void | Promise<void>;
	onDeactivate?: () => void | Promise<void>;
}

export interface SkillRegistryInstance {
	register(skill: AgentSkill): void;
	get(id: string): AgentSkill | undefined;
	getAll(): AgentSkill[];
	getAllTools(): AgentTool[];
	getAllPromptLayers(): PromptLayer[];
	clear(): void;
}

export function createSkillRegistry(): SkillRegistryInstance {
	const skills = new Map<string, AgentSkill>();

	return {
		register(skill: AgentSkill): void {
			skills.set(skill.id, skill);
		},

		get(id: string): AgentSkill | undefined {
			return skills.get(id);
		},

		getAll(): AgentSkill[] {
			return Array.from(skills.values());
		},

		getAllTools(): AgentTool[] {
			return Array.from(skills.values()).flatMap((s) => s.tools ?? []);
		},

		getAllPromptLayers(): PromptLayer[] {
			return Array.from(skills.values()).flatMap((s) => s.promptLayers ?? []);
		},

		clear(): void {
			skills.clear();
		},
	};
}

export const SkillRegistry = createSkillRegistry();
