import { isArtifact } from "../store/artifact-store";
import { canonicalJson, cloneJson } from "../store/json";
import { isToolResult } from "../store/validation";
import { throwIfContextAborted } from "./context-budget";
/** Prepare without writes so invalid summaries and cancelled hooks cannot leave artifacts. */
export async function prepareContextMessages(entries, options) {
    const messages = [];
    const artifacts = [];
    for (const entry of entries) {
        throwIfContextAborted(options.signal);
        const base = { id: entry.id, createdAt: entry.ts };
        if (entry.kind === "user_message")
            messages.push({ ...base, role: "user", content: entry.content });
        else if (entry.kind === "assistant_message")
            messages.push({ ...base, role: "assistant", content: entry.content, ...(entry.toolCalls === undefined ? {} : { toolCalls: entry.toolCalls }) });
        else if (entry.kind === "tool_result") {
            const fullContent = JSON.stringify(entry.result);
            const needsArtifact = options.countTokens(fullContent) > options.maxTokens;
            let content = fullContent;
            if (needsArtifact || entry.artifactId !== undefined) {
                const artifactId = entry.artifactId ?? `context:${encodeURIComponent(options.sessionId)}:${encodeURIComponent(entry.id)}`;
                const artifact = await options.artifactStore.get(artifactId);
                throwIfContextAborted(options.signal);
                if (artifact !== null) {
                    if (!isArtifact(artifact) || artifact.artifactId !== artifactId || artifact.sessionId !== options.sessionId || artifact.contentType !== "application/json" || !isToolResult(artifact.value) || canonicalJson(artifact.value) !== canonicalJson(entry.result)) {
                        throw new TypeError("Tool result artifact does not match its source result");
                    }
                }
                else if (entry.artifactId !== undefined)
                    throw new TypeError("Missing source tool result artifact");
                if (needsArtifact) {
                    const bounded = { success: entry.result.success, message: "", artifactId };
                    const marker = JSON.stringify(bounded);
                    if (options.countTokens(marker) > options.maxTokens)
                        throw new TypeError("maxToolResultTokens cannot fit the artifact marker and result status");
                    let low = 0;
                    let high = entry.result.message.length;
                    content = marker;
                    while (low <= high) {
                        const middle = low + Math.floor((high - low) / 2);
                        const candidate = JSON.stringify({ ...bounded, message: entry.result.message.slice(0, middle) });
                        if (options.countTokens(candidate) <= options.maxTokens) {
                            content = candidate;
                            low = middle + 1;
                        }
                        else
                            high = middle - 1;
                    }
                    if (options.countTokens(content) > options.maxTokens)
                        throw new TypeError("Tokenizer cannot bound tool result projection");
                    if (artifact === null)
                        artifacts.push({ artifactId, sessionId: options.sessionId, contentType: "application/json", value: cloneJson(entry.result) });
                }
            }
            messages.push({ ...base, role: "tool", toolCallId: entry.toolCallId, content });
        }
    }
    return { messages, artifacts };
}
//# sourceMappingURL=context-tools.js.map