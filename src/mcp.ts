import type { AgentTool } from "./tool-types";

export interface MCPToolProvider {
	id: string;
	name: string;
	serverUrl: string;
	listTools(): Promise<AgentTool[]>;
	dispose?(): void | Promise<void>;
}

export interface MCPRegistryInstance {
	register(provider: MCPToolProvider): void;
	get(id: string): MCPToolProvider | undefined;
	getAll(): MCPToolProvider[];
	getAllTools(): Promise<AgentTool[]>;
	dispose(id: string): Promise<void>;
	clear(): Promise<void>;
}

export function createMCPRegistry(): MCPRegistryInstance {
	const providers = new Map<string, MCPToolProvider>();

	return {
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
}

export const MCPRegistry = createMCPRegistry();
