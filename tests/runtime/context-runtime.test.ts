import { expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import type { AgentRuntimeConfig } from "../../src/runtime/contracts";
import { InMemorySessionStore } from "../../src/store/session-store";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentRuntimeEvent } from "../../src/events";
import type { OpenAIMessage, StreamChunk } from "../../src/types";
import type { AgentSessionEntry } from "../../src/store/entries";

async function collect(stream: AsyncGenerator<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function summary(goal: string) {
  return {goal,constraints:["preserve source clips"],completedWork:["earlier edits"],decisions:["serial edits"],failedTools:[],openQuestions:[],nextSteps:["continue current task"],references:["clip-1"]};
}
function stores() {
  return {sessionStore:new InMemorySessionStore(),artifactStore:new InMemoryArtifactStore(),ledger:new InMemoryLedger()};
}

test("55 tool turns compact append-only history while preserving current facts and cached full results", async () => {
  const persistence = stores();
  const model = "long-context-runtime";
  let revision = 1;
  let requests = 0;
  let edits = 0;
  let summaries = 0;
  let ragBuilds = 0;
  const seen: OpenAIMessage[][] = [];
  const llmConfig = {baseUrl:"https://long-context.invalid",apiKey:"not-persisted",model,contextLength:5000,maxOutputTokens:128};
  const dispose = registerLLMBackendFor(config=>config.model === model, {
    type:"long-context",
    async *streamChat(_config,messages): AsyncGenerator<StreamChunk> {
      requests++;
      seen.push(messages);
      if (requests % 2 === 1) yield {type:"tool_calls_complete",toolCalls:[{id:`long-call-${requests}`,type:"function",function:{name:"edit",arguments:"{}"}}]};
      else yield {type:"content_delta",delta:`Edited clip at revision ${revision}. ${"prior reasoning ".repeat(35)}`};
      yield {type:"done",usage:{totalTokens:3}};
    },
  });
  const config: AgentRuntimeConfig = {sessionId:"long-session",...persistence,llmConfig,expertRoleId:"general",tools:[{name:"edit",description:"edit one clip",parameters:{type:"object",properties:{}},execute:async()=>{
    edits++;const before=revision++;return {result:{success:true,message:"edit applied",data:{commandId:`edit-${edits}`,projectRevisionBefore:before,projectRevisionAfter:revision,rows:"full-data-".repeat(200)}},receipt:{operationId:`edit-${edits}`,stateChange:{before:{scopeId:"project",version:String(before)},after:{scopeId:"project",version:String(revision)}}}};
  }}],context:{contextTokens:5000,reserveOutputTokens:128,maxToolResultTokens:128},hooks:{
    getHostSnapshot:()=>({externalStateBinding:{scopeId:"project",version:String(revision)},authoritativeContext:{text:`current-facts-${revision}: clip-1 exists`,producedBy:"host"}}),
    summarizeContext:input=>{summaries++;expect(input.authoritativeContext?.producedBy).toBe("host");return summary(input.previousSummary?.goal ?? "Edit clip-1 without changing the source");},
    buildRagContext:()=>{ragBuilds++;return "clip-1 source is immutable";},
  }};
  try {
    const runtime = createAgentRuntime(config);
    for(let turn=1;turn<=55;turn++) {
      const events=await collect(runtime.run(`Turn ${turn}: adjust clip-1. ${"keep chronology ".repeat(20)}`));
      expect(events.at(-1)!.type).toBe("run_completed");
    }
    expect(edits).toBe(55);
    expect(requests).toBe(110);
    expect(summaries).toBeGreaterThan(1);
    expect(ragBuilds).toBeGreaterThanOrEqual(110);
    const entries=(await persistence.sessionStore.load("long-session"))!.entries;
    expect(entries.filter(entry=>entry.kind === "user_message")).toHaveLength(55);
    expect(entries.filter(entry=>entry.kind === "tool_result")).toHaveLength(55);
    expect(entries.filter(entry=>entry.kind === "compaction").length).toBe(summaries);
    const latest=seen.at(-1)!;
    expect(JSON.stringify(latest)).toContain("current-facts-56");
    expect(JSON.stringify(latest)).toContain("Turn 55:");
    expect(JSON.stringify(latest)).not.toContain("full-data-full-data");
    expect(latest.find(message=>message.role === "tool")!.content).toContain("artifactId");
    expect((await persistence.artifactStore.list("long-session")).some(artifact=>JSON.stringify(artifact.value).includes("full-data-full-data"))).toBe(true);
    const reopened=createAgentRuntime(config);
    const final=await collect(reopened.run("One more turn after reopening"));
    expect(final.at(-1)!.type).toBe("run_completed");
    expect(edits).toBe(56);
  } finally { dispose(); }
}, 30_000);

test("context overflow escalates compaction, output cap and host tool refs before one confirmed execution", async () => {
  const persistence=stores();
  const attempts: {cap:number|undefined;tools:string[]}[]=[];
  let edits=0;
  let filters=0;
  let rag=0;
  const llmConfig={baseUrl:"https://overflow.invalid",apiKey:"key",model:"runtime-overflow",maxOutputTokens:128};
  const dispose=registerLLMBackendFor(config=>config.model === llmConfig.model, {type:"overflow",async *streamChat(config,messages,_signal,tools):AsyncGenerator<StreamChunk>{
    attempts.push({cap:config.maxOutputTokens,tools:(tools??[]).map(tool=>tool.function.name)});
    if(attempts.length<=3){yield {type:"content_delta",delta:"unconfirmed retry text"};yield {type:"tool_calls_complete",toolCalls:[{id:`unconfirmed-${attempts.length}`,type:"function",function:{name:"edit",arguments:"{}"}}]};yield {type:"error",message:"opaque overflow",error:{category:"context_overflow",message:"opaque overflow",retryable:true}};}
    else if(!messages.some(message=>message.role === "tool"))yield {type:"tool_calls_complete",toolCalls:[{id:"confirmed-edit",type:"function",function:{name:"edit",arguments:"{}"}}]};
    else yield {type:"content_delta",delta:"completed after bounded recovery"};
    if(attempts.length>3)yield {type:"done"};
  }});
  const config:AgentRuntimeConfig={sessionId:"overflow",...persistence,llmConfig,expertRoleId:"general",context:{reserveOutputTokens:128},tools:["edit","unneeded"].map(name=>({name,description:name,parameters:{type:"object",properties:{}},execute:async()=>{edits++;return{result:{success:true,message:"applied"}};}})),hooks:{filterTools:()=>{filters++;return["edit"];},buildRagContext:()=>{rag++;return"fresh context";}}};
  try{
    const events=await collect(createAgentRuntime(config).run("edit once"));
    expect(events.at(-1)!.type).toBe("run_completed");
    expect(attempts.slice(0,4)).toEqual([{cap:128,tools:["edit","unneeded"]},{cap:128,tools:["edit","unneeded"]},{cap:64,tools:["edit","unneeded"]},{cap:64,tools:["edit"]}]);
    expect(edits).toBe(1);expect(filters).toBe(1);expect(rag).toBeGreaterThanOrEqual(5);
    const entries=(await persistence.sessionStore.load("overflow"))!.entries;
    expect(JSON.stringify(entries)).not.toContain("unconfirmed retry text");
    expect(entries.filter(entry=>entry.kind === "tool_result").map(entry=>entry.toolCallId)).toEqual(["confirmed-edit"]);
    const retries=(await persistence.ledger.query(events[0]!.runId)).filter(record=>record.event.kind === "retry");
    expect(retries.map(record=>record.event)).toEqual([1,2,3].map(attempt=>({kind:"retry",attempt,category:"context_overflow"})));
  }finally{dispose();}
});

test("exhausted context recovery interrupts durably and resumes the same run without another user message", async()=>{
  const persistence=stores();let overflow=true;let requests=0;
  const llmConfig={baseUrl:"https://exhausted.invalid",apiKey:"key",model:"overflow-resume"};
  const dispose=registerLLMBackendFor(config=>config.model===llmConfig.model,{type:"overflow-resume",async *streamChat():AsyncGenerator<StreamChunk>{requests++;if(overflow)yield{type:"error",message:"opaque overflow",error:{category:"context_overflow",message:"opaque overflow",retryable:true}};else{yield{type:"content_delta",delta:"resumed"};yield{type:"done"};}}});
  const config:AgentRuntimeConfig={sessionId:"exhausted",...persistence,llmConfig,expertRoleId:"general",tools:[],context:{reserveOutputTokens:128}};
  try{
    const interrupted=await collect(createAgentRuntime(config).run("keep this objective"));
    expect(interrupted.at(-1)!.type).toBe("run_interrupted");expect(interrupted.at(-1)!.payload).toMatchObject({cause:"context_overflow"});expect(requests).toBe(4);
    const runId=interrupted[0]!.runId;overflow=false;
    const resumed=await collect(createAgentRuntime(config).resume(runId));
    expect(resumed.at(-1)!.type).toBe("run_completed");expect(resumed.every(event=>event.runId===runId&&event.seq>interrupted.at(-1)!.seq)).toBe(true);
    const entries=(await persistence.sessionStore.load("exhausted"))!.entries;
    expect(entries.filter(entry=>entry.kind==="user_message").map(entry=>entry.content)).toEqual(["keep this objective"]);
    expect(entries.some(entry=>entry.kind==="run_failed")).toBe(false);
  }finally{dispose();}
});

test("compaction storage faults propagate without being retried as provider overflow", async () => {
  class FailingCompactionStore extends InMemorySessionStore {
    fail = false;
    override async append(sessionId: string, entry: AgentSessionEntry): Promise<void> {
      if (this.fail && entry.kind === "compaction") throw {category:"context_overflow",message:"disk commit failed",retryable:false};
      await super.append(sessionId, entry);
    }
  }
  const persistence = {...stores(),sessionStore:new FailingCompactionStore()};
  const llmConfig = {baseUrl:"https://compaction-store.invalid",apiKey:"key",model:"compaction-store",maxOutputTokens:64};
  let requests = 0;
  const dispose = registerLLMBackendFor(config=>config.model === llmConfig.model,{type:"compaction-store",async *streamChat():AsyncGenerator<StreamChunk>{
    requests++;yield {type:"content_delta",delta:"confirmed older response ".repeat(50)};yield {type:"done"};
  }});
  const config:AgentRuntimeConfig = {sessionId:"compaction-store",...persistence,llmConfig,expertRoleId:"general",tools:[],hooks:{
    getHostSnapshot:()=>({authoritativeContext:{text:"facts",producedBy:"host"}}),summarizeContext:()=>summary("preserve original goal"),
  }};
  try {
    const initial = createAgentRuntime(config);
    for (let turn=0;turn<4;turn++) await collect(initial.run(`older question ${turn}`));
    persistence.sessionStore.fail = true;
    await expect(collect(createAgentRuntime({...config,context:{contextTokens:1200,reserveOutputTokens:64,maxToolResultTokens:128}}).run("latest question")))
      .rejects.toMatchObject({category:"context_overflow",message:"disk commit failed"});
    expect(requests).toBe(4);
    const entries = (await persistence.sessionStore.load(config.sessionId))!.entries;
    expect(entries.some(entry=>entry.kind === "compaction")).toBe(false);
    const start = entries.findLast(entry=>entry.kind === "run_started")!;
    if (start.kind !== "run_started") throw new Error("Missing run id");
    expect((await persistence.ledger.query(start.runId)).some(record=>record.event.kind === "retry")).toBe(false);
  } finally { dispose(); }
});

test("runtime enforces its output reserve without changing config-specific backend routing", async () => {
  const persistence = stores();
  const llmConfig = {baseUrl:"https://output-reserve.invalid",apiKey:"key",model:"reserve-routing"};
  const caps: Array<number | undefined> = [];
  const dispose = registerLLMBackendFor(config=>config === llmConfig,{type:"reserve-routing",async *streamChat(config):AsyncGenerator<StreamChunk>{
    caps.push(config.maxOutputTokens);yield {type:"done"};
  }});
  try {
    const events = await collect(createAgentRuntime({sessionId:"reserve",...persistence,llmConfig,expertRoleId:"general",tools:[],context:{reserveOutputTokens:64}}).run("respond"));
    expect(events.at(-1)!.type).toBe("run_completed");
    expect(caps).toEqual([64]);
    expect(Object.hasOwn(llmConfig,"maxOutputTokens")).toBe(false);
  } finally { dispose(); }
});
