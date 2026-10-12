import type { AgentRuntimeEventPayload } from "../events";
import type { IterationHooks, IterationRequestInput } from "./iteration";
import type { PreparedAgentEvent } from "../service";
export type IterationRequestEvent = AgentRuntimeEventPayload | PreparedAgentEvent | {
    kind: "request_attempt_started";
};
/** Recovery owns only request attempts: no history, tools, or iteration advancement. */
export declare function runIterationRequests(input: Omit<IterationRequestInput, "attempt">, hooks: IterationHooks): AsyncGenerator<IterationRequestEvent>;
//# sourceMappingURL=request-attempt.d.ts.map