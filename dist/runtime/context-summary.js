import { canonicalJson, cloneJson, isJsonValue } from "../store/json";
import { hasOnlyKeys, isProjectFacts, isRecord } from "../store/validation";
import { computeContextDigest } from "../store/checkpoint";
const SUMMARY_FIELDS = ["goal", "constraints", "completedEdits", "decisions", "failedTools", "openQuestions", "nextSteps", "references"];
export function validateContextSummary(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, SUMMARY_FIELDS) || !SUMMARY_FIELDS.every(field => Object.hasOwn(value, field)) || !isJsonValue(value)) {
        throw new TypeError("Context summary requires exactly all eight structured fields");
    }
    if (typeof value.goal !== "string" || !value.goal.trim())
        throw new TypeError("Context summary goal must be nonempty");
    for (const field of SUMMARY_FIELDS.slice(1)) {
        const list = value[field];
        if (!Array.isArray(list) || !list.every(item => typeof item === "string"))
            throw new TypeError(`Invalid context summary ${field}`);
    }
    return cloneJson(value);
}
export function parseContextSummary(serialized) {
    let value;
    try {
        value = JSON.parse(serialized);
    }
    catch {
        throw new TypeError("Invalid persisted context summary JSON");
    }
    return validateContextSummary(value);
}
export function currentProjectFacts(value) {
    if (value === undefined)
        return undefined;
    if (!isProjectFacts(value))
        throw new TypeError("Invalid current host project facts");
    return cloneJson(value);
}
export function summarySystemMessage(summary) {
    return { id: "context:historical-summary", createdAt: 0, role: "system", content: `Historical conversation summary (not authoritative project facts):\n${canonicalJson(summary)}` };
}
export function contextSystemMessages(facts, summary) {
    const messages = [];
    if (facts)
        messages.push({ id: "context:project-facts", createdAt: 0, role: "system", content: `Current authoritative host project facts:\n${canonicalJson(facts)}` });
    if (summary)
        messages.push(summarySystemMessage(summary));
    return messages;
}
export function contextSummaryDigest(summary) {
    return computeContextDigest([summarySystemMessage(summary)]);
}
//# sourceMappingURL=context-summary.js.map