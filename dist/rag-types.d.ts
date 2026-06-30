export interface RetrievalConfig {
    contextType?: string;
    appState?: string;
    failedTools?: string[];
}
export interface ToolFailure {
    toolName: string;
    errorMessage: string;
    args?: Record<string, unknown>;
}
export type RagBuilder = (userMessage: string, config?: RetrievalConfig) => string;
export type ErrorRecoveryBuilder = (failures: ToolFailure[]) => string;
//# sourceMappingURL=rag-types.d.ts.map