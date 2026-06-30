export function agentToolToDefinition(tool) {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    };
}
//# sourceMappingURL=tool-types.js.map