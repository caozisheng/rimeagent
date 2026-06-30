export interface PromptLayer {
    id: string;
    content: string;
    priority: number;
}
export interface PromptBuilderConfig {
    identity?: string;
    expertRole?: string;
    activeRole?: string;
    dynamicContext?: string | null;
    ragContext?: string | null;
    workRules?: string;
    customLayers?: PromptLayer[];
}
export declare function buildSystemPrompt(config: PromptBuilderConfig): string;
//# sourceMappingURL=prompt-builder.d.ts.map