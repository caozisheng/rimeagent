import type { AgentSessionConfig, AgentSessionParams } from "../session";
import type { AgentRuntimeEvent } from "../events";
import type { AgentRuntime, AgentRuntimeConfig } from "./contracts";
/** Durable run lifecycle and confirmed-message history. */
export declare function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime;
/** Internal bridge: legacy sessions add no user input and expose their original callback values. */
export declare function createSessionRuntime(params: AgentSessionParams, config: AgentSessionConfig): AsyncGenerator<AgentRuntimeEvent>;
//# sourceMappingURL=runtime.d.ts.map