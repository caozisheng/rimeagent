import { expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import { InMemorySessionStore } from "../../src/store/session-store";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentRuntimeEvent } from "../../src/events";
import type { StreamChunk } from "../../src/types";

async function collect(stream: AsyncGenerator<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[]=[];
  for await(const event of stream)events.push(event);
  return events;
}

for(const changed of ["revision","identity"] as const)test(`project ${changed} changed during streaming cannot rebind and execute the stale plan`,async()=>{
  let revision=1;let projectId="original";let edits=0;
  const llmConfig={baseUrl:"https://stale-plan.invalid",apiKey:"key",model:`stale-${changed}`};
  const store=new InMemorySessionStore();
  const ledger=new InMemoryLedger();
  const dispose=registerLLMBackendFor(config=>config===llmConfig,{type:"stale-plan",async *streamChat():AsyncGenerator<StreamChunk>{
    yield{type:"content_delta",delta:"planning against the original project"};
    if(changed==="revision")revision=2;else projectId="replacement";
    yield{type:"tool_calls_complete",toolCalls:[{id:`stale-${changed}-call`,type:"function",function:{name:"edit",arguments:"{}"}}]};
    yield{type:"done",usage:{totalTokens:3}};
  }});
  try{
    const events=await collect(createAgentRuntime({sessionId:llmConfig.model,sessionStore:store,ledger,llmConfig,expertRoleId:"general",tools:[{name:"edit",description:"edit",parameters:{type:"object",properties:{}},execute:async()=>{edits++;return{success:true,message:"edited wrong project"};}}],hooks:{getProjectFacts:()=>({projectId,projectRevision:revision,digest:"facts",producedBy:"host"})}}).run("edit original project"));
    expect(edits).toBe(0);
    expect(events.at(-1)!.type).toBe("run_failed");
    expect(events.at(-1)!.payload).toMatchObject({error:{category:"tool_failure"}});
    expect((await store.load(llmConfig.model))!.entries.some(entry=>entry.kind==="tool_result")).toBe(false);
    expect((await ledger.query(events[0]!.runId)).find(record=>record.event.kind==="model_call")?.event).toMatchObject({usage:{totalTokens:3}});
  }finally{dispose();}
});

test("final-attempt projection storage faults reject the original error rather than interrupt as provider overflow",async()=>{
  let requests=0;
  const failure={category:"context_overflow" as const,message:"artifact disk commit failed",retryable:false,cause:{private:"caller-only"}};
  class FailedArtifactRead extends InMemoryArtifactStore{
    override async get(id:string){if(requests>=5)throw failure;return super.get(id);}
  }
  const llmConfig={baseUrl:"https://final-store.invalid",apiKey:"key",model:"final-store"};
  const persistence={sessionStore:new InMemorySessionStore(),artifactStore:new FailedArtifactRead(),ledger:new InMemoryLedger()};
  const dispose=registerLLMBackendFor(config=>config===llmConfig,{type:"final-store",async *streamChat():AsyncGenerator<StreamChunk>{
    requests++;
    if(requests===1)yield{type:"tool_calls_complete",toolCalls:[{id:"cached-result-call",type:"function",function:{name:"edit",arguments:"{}"}}]};
    else if(requests>2){yield{type:"error",message:"provider rejected context",error:{category:"context_overflow",message:"provider rejected context",retryable:true}};return;}
    else yield{type:"content_delta",delta:"prior tool completed"};
    yield{type:"done"};
  }});
  try{
    const runtime=createAgentRuntime({sessionId:"final-store",...persistence,llmConfig,expertRoleId:"general",tools:[{name:"edit",description:"edit",parameters:{type:"object",properties:{}},execute:async()=>({success:true,message:"committed",data:{payload:"full result"}})}]});
    await collect(runtime.run("complete prior edit"));
    await expect(collect(runtime.run("trigger overflow"))).rejects.toBe(failure);
    expect(requests).toBe(5);
    const entries=(await persistence.sessionStore.load("final-store"))!.entries;
    expect(entries.at(-1)!.kind).toBe("run_failed");
    expect(JSON.stringify(entries)).not.toContain("caller-only");
  }finally{dispose();}
});

test("input budget covers the final system message counted by a host request tokenizer",async()=>{
  let requests=0;
  const llmConfig={baseUrl:"https://actual-budget.invalid",apiKey:"key",model:"actual-budget",maxOutputTokens:32};
  const dispose=registerLLMBackendFor(config=>config===llmConfig,{type:"actual-budget",async *streamChat():AsyncGenerator<StreamChunk>{requests++;yield{type:"done"};}});
  const tokenizer=(text:string):number=>{
    try{
      const request=JSON.parse(text);
      if(Array.isArray(request.messages))return request.messages.reduce((sum:number,message:unknown)=>sum+JSON.stringify(message).length,0)+JSON.stringify(request.tools??[]).length;
    }catch{/* Text fragments such as individual result summaries. */}
    return text.length;
  };
  try{
    const events=await collect(createAgentRuntime({sessionId:"actual-budget",sessionStore:new InMemorySessionStore(),llmConfig,expertRoleId:"general",identityPrompt:"identity instruction ".repeat(40),tools:[],context:{contextTokens:512,reserveOutputTokens:32,tokenizer}}).run("small user prompt"));
    expect(requests).toBe(0);
    expect(events.at(-1)!.type).toBe("run_interrupted");
    expect(events.at(-1)!.payload).toMatchObject({cause:"context_overflow"});
  }finally{dispose();}
});
