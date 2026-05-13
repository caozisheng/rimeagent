import type { AgentTool } from "./tool-types";

export interface MCPToolProvider {
	id: string;
	name: string;
	serverUrl: string;
	listTools(): Promise<AgentTool[]>;
	dispose?(): void | Promise<void>;
}

const providers = new Map<string, MCPToolProvider>();

export const MCPRegistry = {
	register(provider: MCPToolProvider): void {
		providers.set(provider.id, provider);
	},

	get(id: string): MCPToolProvider | undefined {
		return providers.get(id);
	},

	getAll(): MCPToolProvider[] {
		return Array.from(providers.values());
	},

	async getAllTools(): Promise<AgentTool[]> {
		const results: AgentTool[] = [];
		for (const provider of providers.values()) {
			const tools = await provider.listTools();
			results.push(...tools);
		}
		return results;
	},

	async dispose(id: string): Promise<void> {
		const provider = providers.get(id);
		if (provider?.dispose) await provider.dispose();
		providers.delete(id);
	},

	async clear(): Promise<void> {
		for (const provider of providers.values()) {
			if (provider.dispose) await provider.dispose();
		}
		providers.clear();
	},
};
