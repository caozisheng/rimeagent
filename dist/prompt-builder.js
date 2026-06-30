export function buildSystemPrompt(config) {
    const layers = [];
    if (config.identity) {
        layers.push({ priority: 0, content: config.identity });
    }
    if (config.expertRole) {
        layers.push({ priority: 10, content: config.expertRole });
    }
    if (config.activeRole) {
        layers.push({ priority: 20, content: config.activeRole });
    }
    if (config.dynamicContext) {
        layers.push({ priority: 30, content: config.dynamicContext });
    }
    if (config.ragContext) {
        layers.push({ priority: 40, content: config.ragContext });
    }
    if (config.workRules) {
        layers.push({ priority: 50, content: config.workRules });
    }
    if (config.customLayers) {
        for (const layer of config.customLayers) {
            layers.push({ priority: layer.priority, content: layer.content });
        }
    }
    layers.sort((a, b) => a.priority - b.priority);
    return layers.map((l) => l.content).join("\n\n");
}
//# sourceMappingURL=prompt-builder.js.map