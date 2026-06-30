export function convertTools(tools) {
    return tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}
export function convertMessages(messages) {
    let system;
    const out = [];
    for (const msg of messages) {
        if (msg.role === "system") {
            system = system ? system + "\n\n" + msg.content : (msg.content ?? "");
            continue;
        }
        if (msg.role === "assistant") {
            const blocks = [];
            if (msg.content) {
                blocks.push({ type: "text", text: msg.content });
            }
            if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    let input = {};
                    try {
                        input = JSON.parse(tc.function.arguments);
                    }
                    catch { /* keep empty */ }
                    blocks.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input,
                    });
                }
            }
            out.push({ role: "assistant", content: blocks.length === 0 ? [{ type: "text", text: " " }] : blocks.length === 1 && blocks[0].type === "text" ? (blocks[0].text ?? "") : blocks });
            continue;
        }
        if (msg.role === "tool") {
            const block = {
                type: "tool_result",
                tool_use_id: msg.tool_call_id ?? "",
                content: msg.content ?? "",
            };
            const last = out[out.length - 1];
            if (last?.role === "user" && Array.isArray(last.content)) {
                last.content.push(block);
            }
            else {
                out.push({ role: "user", content: [block] });
            }
            continue;
        }
        // user message
        out.push({ role: "user", content: msg.content ?? "" });
    }
    if (out.length > 0 && out[0].role !== "user") {
        out.unshift({ role: "user", content: "Hello." });
    }
    const merged = [];
    for (const m of out) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === m.role) {
            const prevBlocks = toBlocks(prev.content);
            const curBlocks = toBlocks(m.content);
            prev.content = [...prevBlocks, ...curBlocks];
        }
        else {
            merged.push({ ...m });
        }
    }
    return { system, messages: merged };
}
function toBlocks(content) {
    if (Array.isArray(content))
        return content;
    return [{ type: "text", text: content }];
}
//# sourceMappingURL=anthropic-adapter.js.map