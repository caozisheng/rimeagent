import type { AgentTool } from "./tool-types";
import type { PromptLayer } from "./prompt-builder";

export interface AgentSkill {
	id: string;
	name: string;
	description: string;
	tools?: AgentTool[];
	promptLayers?: PromptLayer[];
	onActivate?: () => void | Promise<void>;
	onDeactivate?: () => void | Promise<void>;
}

const skills = new Map<string, AgentSkill>();

export const SkillRegistry = {
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
