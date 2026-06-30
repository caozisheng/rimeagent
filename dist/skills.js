export function createSkillRegistry() {
    const skills = new Map();
    return {
        register(skill) {
            skills.set(skill.id, skill);
        },
        get(id) {
            return skills.get(id);
        },
        getAll() {
            return Array.from(skills.values());
        },
        getAllTools() {
            return Array.from(skills.values()).flatMap((s) => s.tools ?? []);
        },
        getAllPromptLayers() {
            return Array.from(skills.values()).flatMap((s) => s.promptLayers ?? []);
        },
        clear() {
            skills.clear();
        },
    };
}
export const SkillRegistry = createSkillRegistry();
//# sourceMappingURL=skills.js.map