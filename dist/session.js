import { createSessionRuntime } from "./runtime/runtime";
export async function* runAgentSession(params, config) {
    for await (const event of createSessionRuntime(params, config)) {
        const { payload } = event;
        if ("type" in payload) {
            switch (payload.type) {
                case "text_delta":
                case "tool_calls_complete":
                case "error":
                case "status":
                    yield payload;
                    break;
                case "message_end":
                    yield { type: "message_end", usage: payload.usage };
                    break;
            }
            continue;
        }
        switch (payload.kind) {
            case "iteration_start":
                yield { type: "iteration_start", iteration: payload.iteration };
                break;
            case "tool_result":
                yield { type: "tool_result", toolCall: payload.toolCall, result: payload.result };
                break;
            case "role_switch":
                yield { type: "role_switch", roleId: payload.roleId };
                break;
        }
    }
}
//# sourceMappingURL=session.js.map