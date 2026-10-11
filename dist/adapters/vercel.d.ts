import type { LanguageModel } from "ai";
import type { LLMBackend } from "../llm-backend";
import type { AgentLLMConfig, OpenAIMessage, StreamChunk, ToolDefinition } from "../types";
export type VercelModelResolver = (config: AgentLLMConfig) => LanguageModel | Promise<LanguageModel>;
/** Single-turn transport. Model/provider/proxy construction belongs to the host. */
export declare class VercelAIBackend implements LLMBackend {
    private readonly resolveModel;
    readonly type = "vercel";
    constructor(resolveModel: VercelModelResolver);
    streamChat(config: AgentLLMConfig, messages: OpenAIMessage[], signal?: AbortSignal, tools?: ToolDefinition[]): AsyncGenerator<StreamChunk>;
}
//# sourceMappingURL=vercel.d.ts.map