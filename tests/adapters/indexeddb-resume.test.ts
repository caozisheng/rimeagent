import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDBStores } from "../../src/adapters/indexeddb";
import { createAgentRuntime } from "../../src/runtime/runtime";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentRuntime, AgentRuntimeConfig } from "../../src/runtime/contracts";
import type { AgentRuntimeEvent } from "../../src/events";
import type { AgentTool } from "../../src/tool-types";

async function collect(stream: AsyncGenerator<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("reopening all IndexedDB stores resumes a partial batch without replaying committed edits", async () => {
  const indexedDB = new IDBFactory();
  const llmConfig = {baseUrl:"https://indexeddb-resume.invalid",apiKey:"not-a-persisted-key",model:"idb-resume"};
  const edits: number[] = [];
  const providerTools: string[][] = [];
  let runtime: AgentRuntime;
  let interrupt = true;
  const tools: AgentTool[] = [1,2].map(index => ({
    name:`edit${index}`,description:"Durable edit",parameters:{type:"object",properties:{}},
    execute:async () => {
      edits.push(index);
      if (index === 1 && interrupt) runtime.abort();
      return {success:true,message:`edit ${index} applied`,data:{commandId:`command-${index}`,projectRevisionBefore:7,projectRevisionAfter:7}};
    },
  }));
  const dispose = registerLLMBackendFor(config => config === llmConfig, {
    type:"idb-resume",
    async *streamChat(_config,messages) {
      const results = messages.filter(message=>message.role === "tool").map(message=>message.tool_call_id!);
      providerTools.push(results);
      if (providerTools.length === 1) {
        yield {type:"tool_calls_complete",toolCalls:[1,2].map(index=>({id:`idb-call-${index}`,type:"function" as const,function:{name:`edit${index}`,arguments:"{}"}}))};
      } else {
        yield {type:"content_delta",delta:"both edits complete"};
      }
      yield {type:"done",usage:{totalTokens:6}};
    },
  });
  let stores = await createIndexedDBStores({name:"resume",indexedDB});
  const config = (): AgentRuntimeConfig => ({sessionId:"session",...stores,llmConfig,expertRoleId:"general",tools,
    hooks:{getProjectFacts:()=>({projectId:"project",projectRevision:7,digest:"host-facts",producedBy:"host"})}});
  try {
    runtime = createAgentRuntime(config());
    const first = await collect(runtime.run("apply both edits"));
    const runId = first[0]!.runId;
    expect(first.at(-1)!.type).toBe("run_interrupted");
    expect(edits).toEqual([1]);
    const oldSnapshot = (await stores.sessionStore.load("session"))!;
    const oldLedger = await stores.ledger.query(runId);
    const oldSeq = Math.max(...oldLedger.map(record=>record.seq),...oldSnapshot.entries.filter(entry=>entry.kind === "run_state").map(entry=>entry.seq));
    stores.close();
    stores = await createIndexedDBStores({name:"resume",indexedDB});
    interrupt = false;
    runtime = createAgentRuntime(config());
    const resumed = await collect(runtime.resume(runId));
    expect(resumed.at(-1)!.type).toBe("run_completed");
    expect(resumed.every(event=>event.runId === runId && event.seq > oldSeq)).toBe(true);
    expect(edits).toEqual([1,2]);
    expect(providerTools).toEqual([[],["idb-call-1","idb-call-2"]]);
    const snapshot = (await stores.sessionStore.load("session"))!;
    expect(snapshot.entries.filter(entry=>entry.kind === "user_message").map(entry=>entry.content)).toEqual(["apply both edits"]);
    expect(snapshot.entries.filter(entry=>entry.kind === "tool_result").map(entry=>entry.toolCallId)).toEqual(["idb-call-1","idb-call-2"]);
    const ledger = await stores.ledger.query(runId);
    expect(ledger.filter(record=>record.event.kind === "tool_exec").map(record=>record.event)).toMatchObject([
      {toolCallId:"idb-call-1",commandId:"command-1",projectRevisionBefore:7,projectRevisionAfter:7},
      {toolCallId:"idb-call-2",commandId:"command-2",projectRevisionBefore:7,projectRevisionAfter:7},
    ]);
    expect(ledger.flatMap(record=>record.event.kind === "terminal" ? [record.event.status] : [])).toEqual(["interrupted","completed"]);
    expect(JSON.stringify({snapshot,ledger,artifacts:await stores.artifactStore.list("session")})).not.toContain(llmConfig.apiKey);
  } finally { stores.close(); dispose(); }
});
