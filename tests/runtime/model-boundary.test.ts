import { expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import type { AgentRuntimeConfig } from "../../src/runtime/runtime";
import { InMemorySessionStore } from "../../src/store/session-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import type { LedgerRecord } from "../../src/runtime/ledger";
import type { AgentSessionEntry } from "../../src/store/entries";
import type { AgentRuntimeEvent } from "../../src/events";
import type { StreamChunk } from "../../src/types";
import { registerLLMBackendFor } from "../../src/llm-client";

async function collect(stream: AsyncGenerator<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

for (const switchRole of [false,true]) test(`confirmed ${switchRole ? "role-switch" : "final"} response already has durable model accounting`, async () => {
  const model = `model-boundary-${switchRole}`;
  const llmConfig = {baseUrl:"https://accounting.invalid",apiKey:"base-secret",model};
  const roleConfig = {...llmConfig,model:`role-${model}`,apiKey:"role-secret"};
  const ledger = new InMemoryLedger();
  const atConfirmation: LedgerRecord[][] = [];
  class ObservedStore extends InMemorySessionStore {
    override async append(sessionId: string, entry: AgentSessionEntry): Promise<void> {
      await super.append(sessionId, entry);
      if (entry.kind !== "assistant_message") return;
      const start = (await this.load(sessionId))!.entries.find(item=>item.kind === "run_started")!;
      if (start.kind !== "run_started") throw new Error("Missing run identity");
      atConfirmation.push((await ledger.query(start.runId)).filter(record=>record.event.kind === "model_call"));
    }
  }
  let requests = 0;
  const dispose = registerLLMBackendFor(config=>config === llmConfig || config === roleConfig, {
    type:"accounting-boundary",
    async *streamChat(): AsyncGenerator<StreamChunk> {
      if (++requests === 1 && switchRole) yield {type:"tool_calls_complete",toolCalls:[{id:"boundary-role-call",type:"function",function:{name:"switch_expert_role",arguments:'{"role":"editor"}'}}]};
      else yield {type:"content_delta",delta:"confirmed response"};
      yield {type:"done",usage:{promptTokens:7,completionTokens:3,totalTokens:10,cost:0.02}};
    },
  });
  try {
    const events = await collect(createAgentRuntime({sessionId:model,sessionStore:new ObservedStore(),ledger,llmConfig,expertRoleId:"general",tools:[],hooks:{onRoleSwitch:()=>roleConfig}}).run("respond"));
    expect(events.at(-1)!.type).toBe("run_completed");
    expect(atConfirmation.map(records=>records.length)).toEqual(switchRole ? [1,2] : [1]);
    const records = await ledger.query(events[0]!.runId);
    const calls = records.flatMap(record=>record.event.kind === "model_call" ? [record.event] : []);
    expect(calls.map(call=>call.model)).toEqual(switchRole ? [model,roleConfig.model] : [model]);
  } finally { dispose(); }
});

test("a fresh run resets the configured role/model after the preceding run switches roles", async () => {
  const llmConfig = {baseUrl:"https://fresh-role.invalid",apiKey:"base-key",model:"fresh-base"};
  const roleConfig = {...llmConfig,model:"fresh-editor",apiKey:"editor-key"};
  const store = new InMemorySessionStore();
  const models: string[] = [];
  const dispose = registerLLMBackendFor(config=>config === llmConfig || config === roleConfig, {
    type:"fresh-role",
    async *streamChat(config): AsyncGenerator<StreamChunk> {
      models.push(config.model);
      if (models.length === 1) yield {type:"tool_calls_complete",toolCalls:[{id:"fresh-role-call",type:"function",function:{name:"switch_expert_role",arguments:'{"role":"editor"}'}}]};
      else yield {type:"content_delta",delta:config.model === llmConfig.model ? "base answer" : "editor answer"};
      yield {type:"done"};
    },
  });
  const config: AgentRuntimeConfig = {sessionId:"fresh-role",sessionStore:store,llmConfig,expertRoleId:"general",tools:[],hooks:{onRoleSwitch:()=>roleConfig}};
  try {
    const runtime = createAgentRuntime(config);
    await collect(runtime.run("switch to editor"));
    const fresh = await collect(runtime.run("new configured run"));
    expect(models).toEqual([llmConfig.model,roleConfig.model,llmConfig.model]);
    const snapshot = (await store.load(config.sessionId))!;
    expect(snapshot.entries.filter(entry=>entry.kind === "assistant_message").at(-1)!.content).toBe("base answer");
    const initial = snapshot.entries.find(entry=>entry.kind === "run_state" && entry.runId === fresh[0]!.runId);
    expect(initial).toMatchObject({activeRoleId:"general"});
  } finally { dispose(); }
});
