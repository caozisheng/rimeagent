import { nanoid } from "nanoid";
import type { ToolCall } from "../types";
import type { AgentRuntimeEventPayload } from "../events";
import type { AgentSessionEntry } from "../store/entries";
import type { AgentSessionStore } from "../store/session-store";
import type { AgentArtifactStore } from "../store/artifact-store";
import type { RuntimeLedger, LedgerRecord } from "./ledger";
import type { RuntimeHistory } from "./history";
import type { ProjectFactsDigest } from "./context-manager";
import type { ApprovalGate } from "./approval";
import type { ToolExecutor, ToolExecutorContext } from "./executor";
import { computeProposalDigest } from "./approval";
import { computeContextDigest } from "../store/checkpoint";
import { cloneJson, isJsonValue } from "../store/json";
import { isId } from "../store/validation";
import { rejectRecovery } from "./recovery";
import { SWITCH_ROLE_TOOL_NAME } from "../service";

type ApprovalRequest = Extract<AgentSessionEntry,{kind:"approval_requested"}>;
type ApprovalResolved = Extract<AgentSessionEntry,{kind:"approval_resolved"}>;
export interface RuntimeApprovalOptions {
  sessionId: string;
  sessionStore: AgentSessionStore;
  artifactStore: AgentArtifactStore;
  ledger: RuntimeLedger;
  history: RuntimeHistory;
  executor: ToolExecutor;
  gate: ApprovalGate;
  facts?: () => ProjectFactsDigest;
  onPersistenceFailure: () => void;
}
export interface ApprovalBatchContext extends ToolExecutorContext {
  checkpoint: () => Promise<unknown>;
  recordLedger: (event: LedgerRecord["event"]) => Promise<void>;
}
export type ApprovalBatchResult = {status:"ready";decisions:Readonly<Record<string,"allow"|"deny">>}
  | {status:"awaiting_approval";events:AgentRuntimeEventPayload[]};

function callDigest(call:ToolCall):string {
  return computeContextDigest([{id:"digest",createdAt:0,role:"assistant",content:"",toolCalls:[call]}]);
}
function pendingCall(entries:readonly AgentSessionEntry[],id:string):{runId:string;call:ToolCall} {
  const head=entries.findLast(entry=>entry.kind==="run_started");
  if(!head||head.kind!=="run_started")rejectRecovery("Approval session has no active run");
  if(entries.some(entry=>(entry.kind==="run_completed"||entry.kind==="run_failed")&&entry.runId===head.runId))rejectRecovery("Approval run is already terminal");
  const start=entries.findIndex(entry=>entry.kind==="run_started"&&entry.runId===head.runId);
  const runEntries=entries.slice(start);
  const call=runEntries.flatMap(entry=>entry.kind==="assistant_message"?entry.toolCalls??[]:[]).find(call=>call.id===id);
  if(!call||runEntries.some(entry=>entry.kind==="tool_result"&&entry.toolCallId===id))rejectRecovery("Approval tool call is not pending");
  return{runId:head.runId,call};
}

export function createRuntimeApproval(options:RuntimeApprovalOptions) {
  async function persisted<T>(action:()=>Promise<T>):Promise<T> {
    try{return await action();}catch(cause){options.onPersistenceFailure();throw cause;}
  }
  async function validateRequest(request:ApprovalRequest,call:ToolCall,runId:string):Promise<void> {
    if(request.runId!==runId||request.argsDigest!==callDigest(call))rejectRecovery("Approval request does not match the active call binding");
    const execution = await persisted(() => options.ledger.getToolExecution(call.id));
    const committed = execution?.event.kind === "tool_exec";
    if (committed && (execution.runId !== runId || execution.event.tool !== call.function.name || execution.event.argsDigest !== request.argsDigest)) rejectRecovery("Committed approval execution binding changed");
    // Cached results create no new host effect; recovery already verifies their revision chain.
    if (!committed) {
      const facts = options.facts?.();
      if (request.projectId !== undefined && request.projectId !== facts?.projectId) rejectRecovery("Approval project identity changed");
      if (request.projectRevision !== undefined && request.projectRevision !== facts?.projectRevision) rejectRecovery("Approval project revision changed");
    }
    if((request.proposalDigest===undefined)!==(request.artifactId===undefined))rejectRecovery("Approval proposal binding is incomplete");
    if(request.artifactId){
      const artifact=await persisted(()=>options.artifactStore.get(request.artifactId!));
      if(!artifact||artifact.sessionId!==options.sessionId||artifact.contentType!=="application/json"||!isJsonValue(artifact.value)||computeProposalDigest(artifact.value)!==request.proposalDigest)rejectRecovery("Approval proposal artifact binding changed");
    }
  }
  return {
    async assertBinding(call: ToolCall, runId: string): Promise<void> {
      const entries = await options.history.entries();
      const request = entries.findLast(entry => entry.kind === "approval_requested" && entry.toolCallId === call.id);
      if (request?.kind === "approval_requested") await validateRequest(request, call, runId);
    },
    async prepare(calls:readonly ToolCall[],context:ApprovalBatchContext):Promise<ApprovalBatchResult> {
      const entries=await options.history.entries();
      const decisions:Record<string,"allow"|"deny">=Object.create(null);
      for(const call of calls){
        context.signal?.throwIfAborted();
        if(call.function.name===SWITCH_ROLE_TOOL_NAME){decisions[call.id]="allow";continue;}
        const request=entries.findLast(entry=>entry.kind==="approval_requested"&&entry.toolCallId===call.id);
        if(request?.kind==="approval_requested"){
          await validateRequest(request,call,context.runId);
          const resolved=entries.findLast(entry=>entry.kind==="approval_resolved"&&entry.toolCallId===call.id);
          if(resolved?.kind==="approval_resolved"){
            if(resolved.runId!==context.runId||resolved.proposalDigest!==request.proposalDigest)rejectRecovery("Approval resolution binding does not match the request");
            decisions[call.id]=resolved.decision;continue;
          }
          const events:AgentRuntimeEventPayload[]=[];
          if(request.artifactId&&request.proposalDigest)events.push({kind:"proposal",toolCallId:call.id,artifactId:request.artifactId,proposalDigest:request.proposalDigest});
          await options.history.append({kind:"run_awaiting_approval",runId:context.runId,toolCallId:call.id});
          await context.checkpoint();
          events.push({kind:"run_awaiting_approval",toolCallId:call.id});
          return{status:"awaiting_approval",events};
        }
        const decision = await options.executor.preflight(call, context);
        context.signal?.throwIfAborted();
        if(decision.action!=="suspend"){
          decisions[call.id]=decision.action;
          await context.recordLedger({kind:"approval",toolCallId:call.id,decision:decision.action});
          continue;
        }
        const facts=options.facts?.();
        let artifactId:string|undefined;
        if(decision.proposal!==undefined){
          artifactId=nanoid();
          await persisted(()=>options.artifactStore.put({artifactId:artifactId!,sessionId:options.sessionId,contentType:"application/json",value:cloneJson(decision.proposal!)}));
        }
        context.signal?.throwIfAborted();
        await options.history.append({kind:"approval_requested",runId:context.runId,toolCallId:call.id,reason:decision.reason,argsDigest:callDigest(call),
          ...(facts?.projectId===undefined?{}:{projectId:facts.projectId}),...(facts?.projectRevision===undefined?{}:{projectRevision:facts.projectRevision}),
          ...(artifactId===undefined?{}:{artifactId,proposalDigest:decision.proposalDigest!})});
        const events:AgentRuntimeEventPayload[]=[];
        if(artifactId){
          await options.history.append({kind:"proposal",toolCallId:call.id,proposalDigest:decision.proposalDigest!,artifactId});
          events.push({kind:"proposal",toolCallId:call.id,proposalDigest:decision.proposalDigest!,artifactId});
        }
        await context.recordLedger({kind:"approval",toolCallId:call.id,decision:"suspend"});
        await options.history.append({kind:"run_awaiting_approval",runId:context.runId,toolCallId:call.id});
        await context.checkpoint();
        events.push({kind:"run_awaiting_approval",toolCallId:call.id});
        return{status:"awaiting_approval",events};
      }
      return{status:"ready",decisions};
    },
    async resolve(toolCallId:string,decision:"allow"|"deny",note?:string):Promise<void> {
      if(!isId(toolCallId)||(decision!=="allow"&&decision!=="deny")||(note!==undefined&&typeof note!=="string"))throw new TypeError("Invalid approval resolution");
      const entries=await options.history.entries();
      const pending=pendingCall(entries,toolCallId);
      const request=entries.findLast(entry=>entry.kind==="approval_requested"&&entry.toolCallId===toolCallId);
      if(!request||request.kind!=="approval_requested")rejectRecovery("No pending approval request for this tool call");
      await validateRequest(request,pending.call,pending.runId);
      let resolved=entries.findLast(entry=>entry.kind==="approval_resolved"&&entry.toolCallId===toolCallId);
      let created=false;
      if(resolved?.kind==="approval_resolved"){
        if(resolved.runId!==pending.runId||resolved.decision!==decision||resolved.proposalDigest!==request.proposalDigest)rejectRecovery("Conflicting approval resolution");
      }else{
        const entry:ApprovalResolved={kind:"approval_resolved",id:`approval-resolved:${encodeURIComponent(toolCallId)}`,ts:Date.now(),toolCallId,runId:pending.runId,decision,by:"user",
          ...(note===undefined?{}:{note}),...(request.proposalDigest===undefined?{}:{proposalDigest:request.proposalDigest})};
        try{await options.sessionStore.append(options.sessionId,entry);created=true;resolved=entry;}
        catch(cause){
          const current=await options.history.entries();
          const winner=current.findLast(entry=>entry.kind==="approval_resolved"&&entry.toolCallId===toolCallId);
          if(winner?.kind!=="approval_resolved"){options.onPersistenceFailure();throw cause;}
          if(winner.decision!==decision||winner.runId!==pending.runId||winner.proposalDigest!==request.proposalDigest)rejectRecovery("Conflicting concurrent approval resolution");
          resolved=winner;
        }
      }
      const records=await persisted(()=>options.ledger.query(pending.runId));
      if(!records.some(record=>record.event.kind==="approval"&&record.event.toolCallId===toolCallId&&record.event.decision===decision)){
        let seq=0;
        for(const record of records)seq=Math.max(seq,record.seq);
        for(const entry of entries)if(entry.kind==="run_state"&&entry.runId===pending.runId)seq=Math.max(seq,entry.seq);
        for(const checkpoint of await options.history.checkpoints())if(checkpoint.runId===pending.runId)seq=Math.max(seq,checkpoint.seq??0);
        try {
          await options.ledger.append({ runId: pending.runId, seq: seq + 1, ts: Date.now(), event: { kind: "approval", toolCallId, decision } });
        } catch (cause) {
          const committed = await persisted(() => options.ledger.query(pending.runId));
          if (!committed.some(record => record.event.kind === "approval" && record.event.toolCallId === toolCallId && record.event.decision === decision)) {
            options.onPersistenceFailure();
            throw cause;
          }
        }
      }
      if(created)await options.gate.resolve?.(toolCallId,decision,note);
    },
  };
}
