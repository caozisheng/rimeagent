import type { AgentTool } from "./tool-types";
export interface ToolContext<TEditor = unknown> {
    editor: () => TEditor;
    resolve: {
        element: (query: string) => unknown | null;
        track: (query: string) => unknown | null;
    };
    convert: {
        toInternalUnit: (externalValue: number) => number;
        toExternalUnit: (internalValue: number) => number;
    };
}
export type ToolFactory<TCtx extends ToolContext = ToolContext> = (ctx: TCtx) => AgentTool;
//# sourceMappingURL=tool-context-types.d.ts.map