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
export declare function createExpertRoleRegistry(): ExpertRoleRegistryInstance;
export declare const ExpertRoleRegistry: ExpertRoleRegistryInstance;
//# sourceMappingURL=expert-roles.d.ts.map