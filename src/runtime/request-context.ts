import type { AgentRuntimeConfig } from "./runtime";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentRuntimeEventPayload } from "../events";
import type { NormalizedError } from "../errors";
import type { LedgerRecord } from "./ledger";
import type { IterationRequestInput, PreparedIterationRequest } from "./iteration";
import type { ContextProjection, ContextProjectInput, ProjectFactsDigest } from "./context-manager";
import { createContextManager } from "./context-manager";
import { prepareAgentRequest } from "../service";

export interface RequestContextOptions {
  config: AgentRuntimeConfig;
  artifactStore: AgentArtifactStore;
  signal: AbortSignal;
  assertBoundary: () => Promise<void>;
  recordLedger: (event: LedgerRecord["event"]) => Promise<void>;
  onPersistenceFailure: () => void;
  hasPersistenceFailure: () => boolean;
}
export interface RuntimeRequestContext {
  prepare(input: IterationRequestInput): Promise<PreparedIterationRequest>;
  guardPreparationError(cause: unknown): void;
  recover(error: NormalizedError, attempt: number): Promise<boolean>;
}

/** Storage faults must escape the request retry loop and remain rejected. */
function watchedStores(options: RequestContextOptions): {sessionStore: AgentSessionStore; artifactStore: AgentArtifactStore} {
  async function watch<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (cause) { options.onPersistenceFailure(); throw cause; }
  }
  const session = options.config.sessionStore;
  const artifact = options.artifactStore;
  return {
    sessionStore: {
      load: id => watch(() => session.load(id)),
      append: (id, entry) => watch(() => session.append(id, entry)),
      saveCheckpoint: checkpoint => watch(() => session.saveCheckpoint(checkpoint)),
      listCheckpoints: id => watch(() => session.listCheckpoints(id)),
    },
    artifactStore: {
      put: record => watch(() => artifact.put(record)),
      get: id => watch(() => artifact.get(id)),
      list: id => watch(() => artifact.list(id)),
    },
  };
}

export function createRuntimeRequestContext(options: RequestContextOptions): RuntimeRequestContext {
  const manager = createContextManager({sessionId: options.config.sessionId, ...watchedStores(options),
    config: options.config.context, summarize: options.config.hooks?.summarizeContext});

  async function prepare(input: IterationRequestInput): Promise<PreparedIterationRequest> {
    await options.assertBoundary();
    options.signal.throwIfAborted();
    const events: AgentRuntimeEventPayload[] = [];
    const hooks = options.config.hooks;
    let facts: ProjectFactsDigest | undefined = hooks?.getProjectFacts?.();
    const budget = manager.getBudget(input.params.llmConfig);
    const baseCap = input.params.llmConfig.maxOutputTokens ?? budget.reserveOutputTokens;
    if (!Number.isSafeInteger(baseCap) || baseCap < 1) throw new TypeError("maxOutputTokens must be a positive safe integer");
    const cap = input.attempt >= 2 ? Math.max(1, Math.floor(baseCap / 2)) : baseCap;
    const llmConfig = input.params.llmConfig;

    function buildParams() {
      const dynamicContext = hooks?.buildDynamicContext?.() ?? null;
      const userMessage = input.params.messages.findLast(message => message.role === "user")?.content ?? "";
      const rag = hooks?.buildRagContext?.(userMessage, {appState: dynamicContext ?? undefined,
        failedTools: input.failures.map(failure => failure.toolName)}) ?? "";
      const recovery = input.failures.length ? hooks?.buildErrorRecovery?.([...input.failures]) : undefined;
      return {...input.params, llmConfig, dynamicContext,
        ragContext: recovery ? [rag, recovery].filter(Boolean).join("\n\n") : rag || null};
    }
    let params = buildParams();
    let request = prepareAgentRequest(params);
    let tools = request.tools;
    if (input.attempt >= 3 && hooks?.filterTools) {
      const names = await hooks.filterTools(tools, {activeRoleId: input.params.activeRoleId ?? input.params.expertRoleId,
        projectFacts: facts, failures: input.failures});
      if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !tools.some(tool => tool.function.name === name))) {
        throw new TypeError("filterTools must return registered tool names");
      }
      const allowed = new Set(names);
      tools = tools.filter(tool => allowed.has(tool.function.name));
    }
    const projectInput: ContextProjectInput = {llmConfig,systemPrompt: request.messages[0]?.content ?? "",tools,
      projectFacts: facts, forceCompact: input.attempt === 1, signal: options.signal};
    let projection = await manager.project(projectInput);
    async function recordCompaction(value: ContextProjection): Promise<void> {
      if (!value.compaction) return;
      await options.recordLedger({kind:"compaction",detail:value.compaction.summaryDigest});
      events.push({kind:"compaction_completed",...value.compaction});
    }
    await recordCompaction(projection);
    if (projection.compacted) {
      options.signal.throwIfAborted();
      facts = hooks?.getProjectFacts?.();
      params = buildParams();
      request = prepareAgentRequest(params);
      projection = await manager.project({...projectInput,systemPrompt:request.messages[0]?.content ?? "",projectFacts:facts,forceCompact:false});
      await recordCompaction(projection);
    }
    options.signal.throwIfAborted();
    await options.assertBoundary();
    // Project facts and historical summary are explicit layers before dynamic context.
    const contextLayers = projection.messages.filter(message => message.role === "system")
      .map(message => ({id:message.id,content:message.content,priority:25}));
    const prepared = prepareAgentRequest({...params,messages:projection.messages.filter(message => message.role !== "system"),
      customLayers:[...(params.customLayers ?? []),...contextLayers]});
    const tokensUsed = manager.countTokens(JSON.stringify({messages:prepared.messages,tools}));
    const inputLimit = budget.contextTokens - cap;
    if (tokensUsed > inputLimit) {
      throw {category:"context_overflow",message:`Prepared context uses ${tokensUsed} tokens; input budget is ${inputLimit}`,retryable:true} satisfies NormalizedError;
    }
    return {...prepared,tools,outputTokens:cap,events};
  }
  return {
    prepare,
    guardPreparationError(cause) {
      if (options.hasPersistenceFailure()) throw cause;
    },
    async recover(error, attempt) {
      if (error.category !== "context_overflow" || attempt >= 3) return false;
      options.signal.throwIfAborted();
      await options.recordLedger({kind:"retry",attempt:attempt + 1,category:"context_overflow"});
      return true;
    },
  };
}
