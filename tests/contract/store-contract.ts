import type { AgentSessionStore } from "../../src/store/session-store";
import type { AgentArtifactStore } from "../../src/store/artifact-store";
import type { RuntimeLedger, LedgerRecord } from "../../src/runtime/ledger";
import type { AgentCheckpoint } from "../../src/store/checkpoint";
import type { AgentSessionEntry } from "../../src/store/entries";
import { canonicalJson } from "../../src/store/json";

/** Framework-neutral probes: host SQLite/file adapters can run the same suite. */
export interface StoreContractBundle {
  sessionStore: AgentSessionStore;
  artifactStore: AgentArtifactStore;
  ledger: RuntimeLedger;
  close?: () => void | Promise<void>;
}
export type StoreContractFactory = () => Promise<StoreContractBundle>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Store contract: ${message}`);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert(canonicalJson(JSON.parse(JSON.stringify(actual))) === canonicalJson(JSON.parse(JSON.stringify(expected))), message);
}
async function rejects(action: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, "invalid write must reject");
}
const user = (id: string): Extract<AgentSessionEntry, {kind:"user_message"}> => ({kind:"user_message",id,ts:1,content:"edit"});
const checkpoint = (changes: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  checkpointId:"root",sessionId:"s",createdAt:1,entrySeq:0,contextDigest:"digest",...changes,
});
const record = (seq: number, event: LedgerRecord["event"], runId = "run"): LedgerRecord => ({runId,seq,ts:1,event});

/** Each probe receives fresh empty stores; all writes must be committed on resolve. */
export async function runStoreContract(factory: StoreContractFactory): Promise<string[]> {
  const passed: string[] = [];
  async function probe(name: string, action: (stores: StoreContractBundle) => Promise<void>): Promise<void> {
    const stores = await factory();
    try { await action(stores); passed.push(name); } finally { await stores.close?.(); }
  }
  await probe("append identity and isolation", async ({sessionStore: store}) => {
    equal(await store.load("s"), null, "unknown session must be null");
    await store.append("s", user("z"));
    await store.append("s", user("a"));
    await rejects(() => store.append("s", {...user("z"),content:"overwrite"}));
    await store.append("other", user("z"));
    const first = (await store.load("s"))!;
    equal(first.entries.map(entry=>entry.id), ["z","a"], "append order and duplicate rollback");
    first.entries.pop();
    equal((await store.load("s"))!.entries.map(entry=>entry.id), ["z","a"], "snapshot mutation cannot alter durable history");
    await rejects(() => store.append("invalid", {...user("bad"),kind:"unknown"} as unknown as AgentSessionEntry));
    equal(await store.load("invalid"), null, "invalid append cannot create session");
  });
  await probe("checkpoint ancestry and boundaries", async ({sessionStore: store}) => {
    await rejects(() => store.saveCheckpoint(checkpoint({entrySeq:1})));
    equal(await store.load("s"), null, "invalid checkpoint cannot create session");
    await store.saveCheckpoint(checkpoint());
    equal(await store.load("s"), {sessionId:"s",entries:[]}, "root boundary zero establishes empty session");
    await store.append("s", user("u"));
    await store.saveCheckpoint(checkpoint({checkpointId:"child",parentId:"root",entrySeq:1,runId:"run",seq:9,externalStateBinding:{scopeId:"project",version:"3"}}));
    await rejects(() => store.saveCheckpoint(checkpoint({checkpointId:"past",parentId:"child",entrySeq:0})));
    await rejects(() => store.saveCheckpoint(checkpoint({checkpointId:"cross",sessionId:"other",parentId:"root"})));
    await rejects(() => store.saveCheckpoint(checkpoint({sessionId:"other"})));
    equal(await store.load("other"), null, "invalid ancestry/duplicate cannot create another session");
    equal((await store.listCheckpoints("s")).map(cp=>[cp.checkpointId,cp.entrySeq,cp.externalStateBinding?.version ?? null]), [["root",0,null],["child",1,"3"]], "immutable checkpoint order and recovery binding");
  });
  await probe("artifact immutability", async ({artifactStore: store}) => {
    const input = {artifactId:"artifact",sessionId:"s",contentType:"application/json",value:{result:{success:true}}};
    await store.put(input);
    input.value.result.success = false;
    await rejects(() => store.put({...input,sessionId:"other"}));
    equal((await store.get("artifact"))!.value, {result:{success:true}}, "global artifact duplicate cannot overwrite cache");
    equal(await store.list("other"), [], "duplicate artifact cannot be indexed under another session");
    await rejects(() => store.put({...input,artifactId:"invalid",value:new Date()} as never));
    equal(await store.get("invalid"), null, "invalid artifact cannot reserve id");
  });
  await probe("ledger identity sequence and replay", async ({ledger: store}) => {
    const intent = record(3,{kind:"tool_intent",toolCallId:"call",tool:"edit",argsDigest:"args"});
    await store.append(intent);
    await rejects(() => store.append(record(1,{kind:"terminal",status:"failed"})));
    await rejects(() => store.append(record(4,intent.event,"other")));
    equal(await store.query("other"), [], "duplicate intent rolls back other run");
    assert(!(await store.hasExecuted("call")), "intent alone is not successful execution");
    equal(await store.getToolExecution("call"), intent, "intent is visible to uncertain-effect protection");
    const execution = record(8,{kind:"tool_exec",toolCallId:"call",tool:"edit",argsDigest:"args",outcome:"success",messageDigest:"message",artifactId:"artifact",receipt:{operationId:"command",stateChange:{before:{scopeId:"project",version:"3"},after:{scopeId:"project",version:"4"}}}});
    await store.append(execution);
    assert(await store.hasExecuted("call"), "committed success marks global execution");
    equal(await store.getToolExecution("call"), execution, "replay query returns artifact/command binding");
    equal((await store.query("run")).map(item=>item.seq), [3,8], "invalid seq does not mutate ledger");
    const loaded = await store.query("run"); loaded.pop();
    equal((await store.query("run")).map(item=>item.seq), [3,8], "query mutation cannot erase execution proof");
  });
  await probe("opaque error privacy", async ({sessionStore: store}) => {
    await store.append("s",{kind:"run_failed",id:"error",ts:1,runId:"run",error:{category:"provider",retryable:false,message:"failed",cause:{apiKey:"secret"}}});
    const loaded = (await store.load("s"))!;
    equal(loaded.entries,[{kind:"run_failed",id:"error",ts:1,runId:"run",error:{category:"provider",retryable:false,message:"failed"}}],"opaque causes must not persist");
  });
  await probe("concurrent claims commit once", async ({sessionStore,ledger}) => {
    const entries = await Promise.allSettled([sessionStore.append("s",user("u")),sessionStore.append("s",user("u"))]);
    equal(entries.map(result=>result.status).sort(),["fulfilled","rejected"],"duplicate concurrent entries have one winner");
    const claims = await Promise.allSettled([ledger.append(record(1,{kind:"tool_intent",toolCallId:"call",tool:"edit",argsDigest:"args"})),ledger.append(record(1,{kind:"tool_intent",toolCallId:"call",tool:"edit",argsDigest:"args"},"other"))]);
    equal(claims.map(result=>result.status).sort(),["fulfilled","rejected"],"global intent claims have one winner");
    equal((await sessionStore.load("s"))!.entries,[user("u")],"concurrent losers leave no partial records");
  });
  return passed;
}
