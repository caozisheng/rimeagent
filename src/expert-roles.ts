export interface ExpertRoleDefinition {
	id: string;
	name: string;
	description: string;
	systemPromptAddition: string;
	systemPromptAdditionEn?: string;
	isOrchestrator?: boolean;
}

const roles = new Map<string, ExpertRoleDefinition>();

export const ExpertRoleRegistry = {
	register(role: ExpertRoleDefinition): void {
		roles.set(role.id, role);
	},

	get(id: string): ExpertRoleDefinition | undefined {
		return roles.get(id);
	},

	getAll(): ExpertRoleDefinition[] {
		return Array.from(roles.values());
	},

	getSystemPrompt(id: string, locale?: "zh" | "en"): string {
		const role = roles.get(id);
		if (!role) return "";
		if (locale === "en" && role.systemPromptAdditionEn) {
			return role.systemPromptAdditionEn;
		}
		return role.systemPromptAddition;
	},

	clear(): void {
		roles.clear();
	},
};
