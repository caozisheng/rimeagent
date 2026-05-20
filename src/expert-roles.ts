export interface ExpertRoleDefinition {
	id: string;
	name: string;
	description: string;
	systemPromptAddition: string;
	systemPromptAdditionEn?: string;
	isOrchestrator?: boolean;
}

export interface ExpertRoleRegistryInstance {
	register(role: ExpertRoleDefinition): void;
	get(id: string): ExpertRoleDefinition | undefined;
	getAll(): ExpertRoleDefinition[];
	getSystemPrompt(id: string, locale?: "zh" | "en"): string;
	clear(): void;
}

export function createExpertRoleRegistry(): ExpertRoleRegistryInstance {
	const roles = new Map<string, ExpertRoleDefinition>();

	return {
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
}

export const ExpertRoleRegistry = createExpertRoleRegistry();
