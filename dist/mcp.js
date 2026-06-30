export function createMCPRegistry() {
    const providers = new Map();
    return {
        register(provider) {
            providers.set(provider.id, provider);
        },
        get(id) {
            return providers.get(id);
        },
        getAll() {
            return Array.from(providers.values());
        },
        async getAllTools() {
            const results = [];
            for (const provider of providers.values()) {
                const tools = await provider.listTools();
                results.push(...tools);
            }
            return results;
        },
        async dispose(id) {
            const provider = providers.get(id);
            if (provider?.dispose)
                await provider.dispose();
            providers.delete(id);
        },
        async clear() {
            for (const provider of providers.values()) {
                if (provider.dispose)
                    await provider.dispose();
            }
            providers.clear();
        },
    };
}
export const MCPRegistry = createMCPRegistry();
//# sourceMappingURL=mcp.js.map