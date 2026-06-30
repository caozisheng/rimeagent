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
export declare function createSkillRegistry(): SkillRegistryInstance;
export declare const SkillRegistry: SkillRegistryInstance;
//# sourceMappingURL=skills.d.ts.map