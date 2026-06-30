export function createExpertRoleRegistry() {
    const roles = new Map();
    return {
        register(role) {
            roles.set(role.id, role);
        },
        get(id) {
            return roles.get(id);
        },
        getAll() {
            return Array.from(roles.values());
        },
        getSystemPrompt(id, locale) {
            const role = roles.get(id);
            if (!role)
                return "";
            if (locale === "en" && role.systemPromptAdditionEn) {
                return role.systemPromptAdditionEn;
            }
            return role.systemPromptAddition;
        },
        clear() {
            roles.clear();
        },
    };
}
export const ExpertRoleRegistry = createExpertRoleRegistry();
//# sourceMappingURL=expert-roles.js.map