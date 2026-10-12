import { expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/runtime/runtime";
import type { AgentRuntimeConfig } from "../../src/runtime/contracts";
import { InMemorySessionStore } from "../../src/store/session-store";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { computeContextDigest } from "../../src/store/checkpoint";
import { registerLLMBackendFor } from "../../src/llm-client";
import type { AgentRuntimeEvent } from "../../src/events";
import type { StreamChunk } from "../../src/types";
import type { AgentTool } from "../../src/tool-types";

async function collect(stream: AsyncGenerator<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[]=[];
  for await(const event of stream)events.push(event);
  return events;
}
function setup(model:string,turn:(messages:readonly {role:string;content:string|null;tool_call_id?:string}[],request:number)=>AsyncGenerator<StreamChunk>) {
  const stores={sessionStore:new InMemorySessionStore(),artifactStore:new InMemoryArtifactStore(),ledger:new InMemoryLedger()};
  const llmConfig={baseUrl:"https://approval-runtime.invalid",apiKey:"never-persisted",model};
  let requests=0;
  const dispose=registerLLMBackendFor(config=>config===llmConfig,{type:"approval-runtime",async *streamChat(_config,messages){yield* turn(messages,++requests);}});
  const config:AgentRuntimeConfig={sessionId:model,...stores,llmConfig,expertRoleId:"general",maxIterations:3,tools:[]};
  return{stores,config,dispose,requests:()=>requests};
}
const sensitiveCall=(id="protected-call")=>({id,type:"function" as const,function:{name:"publish",arguments:"{}"}});

test("approval suspension persists pending batch and resumes same toolCallId exactly once after reload",async()=>{
  let effects=0;
  const fixture=setup("approval-reopen",async function*(_messages,request){
    if(request===1)yield{type:"tool_calls_complete",toolCalls:[sensitiveCall()]};
    else yield{type:"content_delta",delta:"Published safely after approval."};
    yield{type:"done",usage:{totalTokens:3}};
  });
  const tools:AgentTool[]=[{name:"publish",description:"publish the render",parameters:{type:"object",properties:{}},annotations:{requiresApproval:true},execute:async()=>{effects++;return{success:true,message:"published"};}}];
  const config:AgentRuntimeConfig={...fixture.config,tools};
  try{
    const runtime=createAgentRuntime(config);
    const suspended=await collect(runtime.run("Publish after review"));
    const runId=suspended[0]!.runId;
    expect(suspended.at(-1)!.type).toBe("run_awaiting_approval");
    expect(suspended.at(-1)!.payload).toMatchObject({toolCallId:"protected-call"});
    expect(effects).toBe(0);
    expect(fixture.requests()).toBe(1);
    let snapshot=(await fixture.stores.sessionStore.load(config.sessionId))!;
    expect(snapshot.entries.some(entry=>entry.kind==="approval_requested"&&entry.toolCallId==="protected-call")).toBe(true);
    expect(snapshot.entries.some(entry=>entry.kind==="run_awaiting_approval"&&entry.runId===runId)).toBe(true);
    const reopened=createAgentRuntime(config);
    await reopened.resolveApproval("protected-call","allow");
    snapshot=(await fixture.stores.sessionStore.load(config.sessionId))!;
    expect(snapshot.entries.some(entry=>entry.kind==="approval_resolved"&&entry.toolCallId==="protected-call"&&entry.decision==="allow")).toBe(true);
    const resumed=await collect(reopened.resume(runId));
    expect(resumed[0]!.type).toBe("run_resumed");
    expect(resumed.at(-1)!.type).toBe("run_completed");
    expect(resumed.every(event=>event.runId===runId&&event.seq>suspended.at(-1)!.seq)).toBe(true);
    snapshot=(await fixture.stores.sessionStore.load(config.sessionId))!;
    expect(effects).toBe(1);
    expect(fixture.requests()).toBe(2);
    expect(snapshot.entries.filter(entry=>entry.kind==="user_message").map(entry=>entry.content)).toEqual(["Publish after review"]);
    expect(snapshot.entries.filter(entry=>entry.kind==="tool_result").map(entry=>entry.toolCallId)).toEqual(["protected-call"]);
    expect(JSON.stringify(snapshot)+JSON.stringify(await fixture.stores.ledger.query(runId))+JSON.stringify(await fixture.stores.artifactStore.list(config.sessionId))).not.toContain(config.llmConfig.apiKey);
  }finally{fixture.dispose();}
});

test("denial creates a durable failure result without executing the gated tool",async()=>{
  let effects=0;
  const fixture=setup("approval-deny",async function*(_messages,request){
    if(request===1)yield{type:"tool_calls_complete",toolCalls:[sensitiveCall("deny-call")]};
    else {expect(_messages.some(message=>message.role==="tool"&&message.tool_call_id==="deny-call")).toBe(true);yield{type:"content_delta",delta:"Denied safely."};}
    yield{type:"done"};
  });
  const config:AgentRuntimeConfig={...fixture.config,tools:[{name:"publish",description:"publish",parameters:{type:"object",properties:{}},annotations:{destructive:true},execute:async()=>{effects++;return{success:true,message:"unsafe"};}}]};
  try{
    const runtime=createAgentRuntime(config);
    const suspended=await collect(runtime.run("Publish?"));
    await runtime.resolveApproval("deny-call","deny","user declined");
    const resumed=await collect(runtime.resume(suspended[0]!.runId));
    expect(resumed.at(-1)!.type).toBe("run_completed");expect(effects).toBe(0);expect(fixture.requests()).toBe(2);
    const snapshot=(await fixture.stores.sessionStore.load(config.sessionId))!;
    expect(snapshot.entries.find(entry=>entry.kind==="tool_result"&&entry.toolCallId==="deny-call")).toMatchObject({result:{success:false}});
    expect(snapshot.entries.find(entry=>entry.kind==="approval_resolved"&&entry.toolCallId==="deny-call")).toMatchObject({decision:"deny",note:"user declined"});
  }finally{fixture.dispose();}
});

test("approval cannot resume after project revision changes",async()=>{
  let revision=4;let effects=0;
  const fixture=setup("approval-revision",async function*(_messages,request){
    if(request===1)yield{type:"tool_calls_complete",toolCalls:[sensitiveCall("revision-call")]};else yield{type:"done"};
  });
  const config:AgentRuntimeConfig={...fixture.config,tools:[{name:"publish",description:"publish",parameters:{type:"object",properties:{}},annotations:{requiresApproval:true},execute:async()=>{effects++;return{success:true,message:"published"};}}],hooks:{getProjectFacts:()=>({projectId:"project",projectRevision:revision,digest:"facts",producedBy:"host"})}};
  try{
    const runtime=createAgentRuntime(config);const suspended=await collect(runtime.run("Publish?"));await runtime.resolveApproval("revision-call","allow");revision++;
    await expect(collect(runtime.resume(suspended[0]!.runId))).rejects.toMatchObject({category:"tool_failure"});
    expect(effects).toBe(0);expect(fixture.requests()).toBe(1);
  }finally{fixture.dispose();}
});

test("approval resolves once and rejects foreign, conflicting or not-pending decisions",async()=>{
  const fixture=setup("approval-identity",async function*(){yield{type:"tool_calls_complete",toolCalls:[sensitiveCall("one-call")]};yield{type:"done"};});
  const config:AgentRuntimeConfig={...fixture.config,tools:[{name:"publish",description:"publish",parameters:{type:"object",properties:{}},annotations:{requiresApproval:true},execute:async()=>({success:true,message:"published"})}]};
  try{
    const runtime=createAgentRuntime(config);await collect(runtime.run("approve"));
    await expect(runtime.resolveApproval("foreign-call","allow")).rejects.toMatchObject({category:"tool_failure"});
    await runtime.resolveApproval("one-call","allow");await runtime.resolveApproval("one-call","allow");
    await expect(runtime.resolveApproval("one-call","deny")).rejects.toMatchObject({category:"tool_failure"});
    const entries=(await fixture.stores.sessionStore.load(config.sessionId))!.entries;
    expect(entries.filter(entry=>entry.kind==="approval_resolved"&&entry.toolCallId==="one-call")).toHaveLength(1);
  }finally{fixture.dispose();}
});

test("approval cannot authorize a later call after an earlier batch edit changes its bound revision", async () => {
  let revision = 4;
  let edits = 0;
  let publications = 0;
  const fixture = setup("approval-batch-revision", async function* (_messages, request) {
    if (request === 1) yield { type: "tool_calls_complete", toolCalls: [
      { id: "earlier-edit", type: "function", function: { name: "edit", arguments: "{}" } }, sensitiveCall(),
    ] };
    yield { type: "done" };
  });
  const config: AgentRuntimeConfig = { ...fixture.config, tools: [
    { name: "edit", description: "edit", parameters: { type: "object" }, execute: async () => {
      edits++; revision++; return { success: true, message: "edited" };
    } },
    { name: "publish", description: "publish", parameters: { type: "object" }, annotations: { requiresApproval: true }, execute: async () => {
      publications++; return { success: true, message: "published" };
    } },
  ], hooks: { getProjectFacts: () => ({ producedBy: "host", projectId: "project", projectRevision: revision, digest: "facts" }) } };
  try {
    const runtime = createAgentRuntime(config);
    const suspended = await collect(runtime.run("Edit and publish after review"));
    expect(edits).toBe(0);
    await runtime.resolveApproval("protected-call", "allow");
    const resumed = await collect(runtime.resume(suspended[0]!.runId));
    expect(edits).toBe(1);
    expect(publications).toBe(0);
    expect(resumed.at(-1)!.type).toBe("run_failed");
  } finally { fixture.dispose(); }
});

test("committed approved edits replay after a crash without requiring the old project revision", async () => {
  let revision = 4;
  let effects = 0;
  const fixture = setup("approval-committed-crash", async function* (_messages, request) {
    if (request === 1) yield { type: "tool_calls_complete", toolCalls: [sensitiveCall()] };
    yield { type: "done" };
  });
  const config: AgentRuntimeConfig = { ...fixture.config, tools: [{ name: "publish", description: "publish", parameters: { type: "object" }, annotations: { requiresApproval: true }, execute: async () => {
    effects++; return { success: true, message: "duplicate" };
  } }], hooks: { getProjectFacts: () => ({ producedBy: "host", projectId: "project", projectRevision: revision, digest: "facts" }) } };
  try {
    const runtime = createAgentRuntime(config);
    const suspended = await collect(runtime.run("Publish"));
    const runId = suspended[0]!.runId;
    await runtime.resolveApproval("protected-call", "allow");
    // Simulate the durable host effect/result committing before session result append.
    effects++; revision++;
    const call = sensitiveCall();
    const argsDigest = computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
    await fixture.stores.artifactStore.put({ artifactId: "committed-result", sessionId: config.sessionId, contentType: "application/json", value: { success: true, message: "published" } });
    const records = await fixture.stores.ledger.query(runId);
    await fixture.stores.ledger.append({ runId, seq: Math.max(...records.map(record => record.seq)) + 1, ts: 0, event: { kind: "tool_exec", toolCallId: call.id, tool: "publish", argsDigest, outcome: "success", messageDigest: "message", artifactId: "committed-result", projectRevisionBefore: 4, projectRevisionAfter: 5 } });
    const resumed = await collect(createAgentRuntime(config).resume(runId));
    expect(resumed.at(-1)!.type).toBe("run_completed");
    expect(effects).toBe(1);
    expect((await fixture.stores.sessionStore.load(config.sessionId))!.entries.find(entry => entry.kind === "tool_result")).toMatchObject({ result: { success: true, message: "published" } });
  } finally { fixture.dispose(); }
});

test.each([
  { decision: "deny" as const, result: { success: false, message: "approval_denied" }, recoverable: true },
  { decision: "allow" as const, result: { success: false, message: "approval_denied" }, recoverable: false },
  { decision: "deny" as const, result: { success: true, message: "approval_denied" }, recoverable: false },
])("denial checkpoint suffix requires the matching decision and exact failed result: %j", async ({ decision, result, recoverable }) => {
  let effects = 0;
  const fixture = setup("approval-denial-crash", async function* (_messages, request) {
    if (request === 1) yield { type: "tool_calls_complete", toolCalls: [sensitiveCall()] };
    else expect(_messages.find(message => message.role === "tool")?.content).toBe(JSON.stringify({ success: false, message: "approval_denied" }));
    yield { type: "done" };
  });
  const config: AgentRuntimeConfig = { ...fixture.config, tools: [{ name: "publish", description: "publish", parameters: { type: "object" }, annotations: { requiresApproval: true }, execute: async () => { effects++; return { success: true, message: "unsafe" }; } }] };
  try {
    const runtime = createAgentRuntime(config);
    const suspended = await collect(runtime.run("Publish?"));
    await runtime.resolveApproval("protected-call", decision);
    await fixture.stores.sessionStore.append(config.sessionId, { kind: "tool_result", id: "denial-before-checkpoint", ts: 0, toolCallId: "protected-call", result });
    const resumed = collect(createAgentRuntime(config).resume(suspended[0]!.runId));
    if (recoverable) expect((await resumed).at(-1)!.type).toBe("run_completed");
    else await expect(resumed).rejects.toMatchObject({ category: "tool_failure" });
    expect(effects).toBe(0);
  } finally { fixture.dispose(); }
});

test("concurrent identical resolutions reconcile ledger claims and notify once", async () => {
  const ready = Promise.withResolvers<void>();
  class RacingLedger extends InMemoryLedger {
    armed = false;
    queries = 0;
    override async query(runId: string) {
      const records = await super.query(runId);
      if (this.armed && ++this.queries <= 2) {
        if (this.queries === 2) ready.resolve();
        await ready.promise;
      }
      return records;
    }
  }
  const ledger = new RacingLedger();
  let notifications = 0;
  const fixture = setup("approval-concurrent", async function* () { yield { type: "tool_calls_complete", toolCalls: [sensitiveCall()] }; yield { type: "done" }; });
  const config: AgentRuntimeConfig = { ...fixture.config, ledger, approval: { preflight: () => ({ action: "suspend", reason: "Review" }), resolve: async () => { notifications++; } }, tools: [{ name: "publish", description: "publish", parameters: { type: "object" }, execute: async () => ({ success: true, message: "published" }) }] };
  try {
    const runtime = createAgentRuntime(config);
    const suspended = await collect(runtime.run("Publish?"));
    ledger.armed = true;
    const results = await Promise.allSettled([runtime.resolveApproval("protected-call", "allow"), createAgentRuntime(config).resolveApproval("protected-call", "allow")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(notifications).toBe(1);
    expect((await ledger.query(suspended[0]!.runId)).filter(record => record.event.kind === "approval" && record.event.decision === "allow")).toHaveLength(1);
  } finally { fixture.dispose(); }
});

test("preflight ledger read failures reject with the original adapter exception", async () => {
  const failure = new Error("Replay index unavailable");
  class BrokenReplayLedger extends InMemoryLedger {
    override async getToolExecution(): Promise<never> { throw failure; }
  }
  let effects = 0;
  const fixture = setup("approval-preflight-storage", async function* () {
    yield { type: "tool_calls_complete", toolCalls: [sensitiveCall()] };
    yield { type: "done" };
  });
  try {
    const runtime = createAgentRuntime({ ...fixture.config, ledger: new BrokenReplayLedger(), tools: [{ name: "publish", description: "publish", parameters: { type: "object" }, execute: async () => { effects++; return { success: true, message: "unsafe" }; } }] });
    await expect(collect(runtime.run("Publish"))).rejects.toBe(failure);
    expect(effects).toBe(0);
    expect(runtime.state).toBe("settled");
  } finally { fixture.dispose(); }
});
