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
export declare function createMCPRegistry(): MCPRegistryInstance;
export declare const MCPRegistry: MCPRegistryInstance;
//# sourceMappingURL=mcp.d.ts.map