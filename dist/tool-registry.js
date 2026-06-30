import { agentToolToDefinition } from "./tool-types";
export function createToolRegistry() {
    const tools = new Map();
    return {
        register(tool) {
            tools.set(tool.name, tool);
        },
        get(name) {
            return tools.get(name);
        },
        getAll() {
            return Array.from(tools.values());
        },
        getDefinitions() {
            return Array.from(tools.values()).map(agentToolToDefinition);
        },
        async executeToolCall(toolCall) {
            const { name, arguments: argsStr } = toolCall.function;
            let args;
            try {
                args = JSON.parse(argsStr);
            }
            catch {
                return { success: false, message: "Invalid JSON arguments" };
            }
            const tool = tools.get(name);
            if (!tool) {
                return { success: false, message: `Unknown tool: ${name}` };
            }
            try {
                return await tool.execute(args);
            }
            catch (err) {
                return {
                    success: false,
                    message: err instanceof Error ? err.message : "Tool execution failed",
                };
            }
        },
        clear() {
            tools.clear();
        },
    };
}
export const ToolRegistry = createToolRegistry();
//# sourceMappingURL=tool-registry.js.map