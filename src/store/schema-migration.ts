import type { AgentCheckpoint } from "./checkpoint";
import type { AgentSessionEntry } from "./entries";
import type { LedgerRecord } from "../runtime/ledger";
import type { ExternalStateBinding } from "../tool-types";
import { computeContextDigest } from "./checkpoint";
import { canonicalJson } from "./json";
import { isArtifact, type AgentArtifact } from "./artifact-store";
import { isCheckpoint } from "./session-store";
import { isAgentSessionEntry, isCount, isId, isRecord, isToolResult } from "./validation";
import { isLedgerRecord } from "../runtime/ledger";
import { projectMessages } from "../runtime/history";
import { computeProposalDigest } from "../runtime/approval";
import { validateContextSummary } from "../runtime/context-summary";

export const AGENT_STORE_SCHEMA_VERSION = 2 as const;

function legacyBinding(value: Record<string, unknown>): ExternalStateBinding | undefined {
  const hasId = Object.hasOwn(value, "projectId");
  const hasRevision = Object.hasOwn(value, "projectRevision");
  if (hasId !== hasRevision) throw new TypeError("Incomplete legacy project binding");
  if (!hasId) return undefined;
  if (!isId(value.projectId) || !isCount(value.projectRevision)) throw new TypeError("Invalid legacy project binding");
  return { scopeId: value.projectId, version: String(value.projectRevision) };
}

/** Converts only validated legacy durable fields; never reads result.data as metadata. */
export function convertLegacyCheckpoint(value: unknown): AgentCheckpoint {
  if (!isRecord(value)) throw new TypeError("Invalid legacy checkpoint");
  const { projectId: _id, projectRevision: _revision, projectCheckpointId: _host, ...rest } = value;
  if (Object.hasOwn(value, "projectCheckpointId") && !isId(value.projectCheckpointId)) throw new TypeError("Invalid legacy host checkpoint");
  const binding = legacyBinding(value);
  const converted = { ...rest, ...(binding === undefined ? {} : { externalStateBinding: binding }) };
  if (!isCheckpoint(converted)) throw new TypeError("Invalid converted checkpoint");
  return converted;
}

export function convertLegacyEntry(value: unknown): AgentSessionEntry {
  if (!isRecord(value) || !isId(value.kind)) throw new TypeError("Invalid legacy entry");
  let converted: Record<string, unknown>;
  if (value.kind === "approval_requested") {
    const { projectId: _id, projectRevision: _revision, ...rest } = value;
    const binding = legacyBinding(value);
    converted = { ...rest, ...(binding === undefined ? {} : { externalStateBinding: binding }) };
  } else if (value.kind === "compaction") {
    const { projectDigest, ...rest } = value;
    if (!isRecord(projectDigest) || !Object.keys(projectDigest).every(key => ["projectId", "projectRevision", "digest", "summary", "producedBy"].includes(key))
      || projectDigest.producedBy !== "host" || !isCount(projectDigest.projectRevision)
      || !isId(projectDigest.digest) || (projectDigest.projectId !== undefined && !isId(projectDigest.projectId))
      || (projectDigest.summary !== undefined && typeof projectDigest.summary !== "string")) throw new TypeError("Invalid legacy compaction facts");
    if (typeof rest.summary !== "string") throw new TypeError("Invalid legacy compaction summary");
    let summary: unknown;
    try { summary = JSON.parse(rest.summary); } catch { throw new TypeError("Invalid legacy compaction summary"); }
    if (!isRecord(summary) || !Array.isArray(summary.completedEdits) || !summary.completedEdits.every(item => typeof item === "string")) throw new TypeError("Invalid legacy completed work");
    const { completedEdits, ...fields } = summary;
    converted = { ...rest, summary: canonicalJson(validateContextSummary({ ...fields, completedWork: completedEdits })) };
  } else if (value.kind === "tool_result" && isRecord(value.result) && Object.hasOwn(value.result, "undoable")) {
    converted = { ...value, legacyResult: true };
  } else if (value.kind === "checkpoint") {
    const { projectRevision, ...rest } = value;
    if (projectRevision !== undefined && !isCount(projectRevision)) throw new TypeError("Invalid legacy checkpoint entry revision");
    converted = rest;
  } else converted = value;
  if (!isAgentSessionEntry(converted)) throw new TypeError("Invalid converted session entry");
  return converted;
}

export function convertLegacyLedger(value: unknown, binding?: ExternalStateBinding): LedgerRecord {
  if (!isRecord(value) || !isRecord(value.event)) throw new TypeError("Invalid legacy ledger");
  if (value.event.kind !== "tool_exec") {
    if (!isLedgerRecord(value)) throw new TypeError("Invalid legacy ledger record");
    return value;
  }
  if (!Object.keys(value.event).every(key => ["kind", "toolCallId", "tool", "argsDigest", "outcome", "messageDigest", "artifactId", "commandId", "projectRevisionBefore", "projectRevisionAfter"].includes(key))) throw new TypeError("Unknown legacy ledger metadata");
  const { commandId, projectRevisionBefore, projectRevisionAfter, ...rest } = value.event;
  if ((projectRevisionBefore === undefined) !== (projectRevisionAfter === undefined)) throw new TypeError("Incomplete legacy committed state change");
  if (commandId !== undefined && !isId(commandId)) throw new TypeError("Invalid legacy committed command id");
  if (projectRevisionBefore !== undefined && (!isCount(projectRevisionBefore) || !isCount(projectRevisionAfter) || !binding)) throw new TypeError("Unbound legacy committed state change");
  if (commandId !== undefined && !binding) throw new TypeError("Unbound legacy command id");
  const receipt = {
    ...(commandId === undefined ? {} : { operationId: commandId }),
    ...(projectRevisionBefore === undefined ? {} : { stateChange: { before: { scopeId: binding!.scopeId, version: String(projectRevisionBefore) }, after: { scopeId: binding!.scopeId, version: String(projectRevisionAfter) } } }),
  };
  const converted = { ...value, event: { ...rest, ...(Object.keys(receipt).length ? { receipt } : {}) } };
  if (!isLedgerRecord(converted)) throw new TypeError("Invalid converted ledger record");
  return converted;
}

export interface LegacySessionGroup {
  readonly sessionId: string;
  readonly entries: readonly unknown[];
  readonly checkpoints: readonly unknown[];
  readonly artifacts: readonly unknown[];
  readonly ledger: readonly unknown[];
}

/** Pure, fail-closed conversion for the complete session's references and digests. */
export function convertLegacySession(group: LegacySessionGroup): {
  entries: AgentSessionEntry[]; checkpoints: AgentCheckpoint[]; ledger: LedgerRecord[];
} {
  if (!isId(group.sessionId)) throw new TypeError("Invalid legacy session id");
  // A checkpoint digest covers the original model-visible tool JSON. Do not
  // rewrite legacy tool_result entries or their immutable artifacts.
  const entries = group.entries.map(convertLegacyEntry);
  const checkpoints = group.checkpoints.map(convertLegacyCheckpoint);
  const artifacts = new Map<string, AgentArtifact>();
  for (const value of group.artifacts) {
    if (!isArtifact(value) || value.sessionId !== group.sessionId || artifacts.has(value.artifactId)) throw new TypeError("Invalid legacy artifact reference");
    artifacts.set(value.artifactId, value);
  }
  const runs = new Map<string, AgentSessionEntry[]>();
  let currentRun: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "run_started") currentRun = entry.runId;
    if (currentRun) {
      const items = runs.get(currentRun) ?? [];
      items.push(entry);
      runs.set(currentRun, items);
    }
  }
  for (const checkpoint of checkpoints) {
    if (checkpoint.sessionId !== group.sessionId || checkpoint.entrySeq > entries.length
      || checkpoint.parentId && !checkpoints.some(item => item.checkpointId === checkpoint.parentId && item.entrySeq <= checkpoint.entrySeq)) throw new TypeError("Invalid legacy checkpoint reference");
    if (computeContextDigest(projectMessages(entries.slice(0, checkpoint.entrySeq))) !== checkpoint.contextDigest) throw new TypeError("Legacy checkpoint digest mismatch");
    if (checkpoint.runId && !runs.has(checkpoint.runId)) throw new TypeError("Cross-session legacy checkpoint run");
  }
  const ledger: LedgerRecord[] = [];
  for (const raw of group.ledger) {
    if (!isRecord(raw) || !isId(raw.runId) || !runs.has(raw.runId)) throw new TypeError("Legacy ledger has unknown run");
    const bound = checkpoints.filter(item => item.runId === raw.runId && item.externalStateBinding !== undefined).at(-1)?.externalStateBinding;
    const record = convertLegacyLedger(raw, bound);
    if (record.event.kind === "tool_exec") {
      const event = record.event;
      const call = runs.get(record.runId)!.flatMap(item => item.kind === "assistant_message" ? item.toolCalls ?? [] : []).find(item => item.id === event.toolCallId);
      const digest = call && computeContextDigest([{ id: "digest", role: "assistant", createdAt: 0, content: "", toolCalls: [call] }]);
      const artifact = event.artifactId && artifacts.get(event.artifactId);
      if (!call || call.function.name !== event.tool || event.argsDigest !== digest || !artifact || !isToolResult(artifact.value)
        || artifact.value.success !== (event.outcome === "success")) throw new TypeError("Unverified legacy tool execution");
      const bytes = new TextEncoder().encode(canonicalJson(artifact.value.message));
      let hash = 0x811c9dc5;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
      if (hash.toString(16).padStart(8, "0") !== event.messageDigest) throw new TypeError("Legacy tool execution digest mismatch");
    }
    ledger.push(record);
  }
  for (const entry of entries) {
    if (entry.kind === "tool_result" && entry.artifactId) {
      const artifact = artifacts.get(entry.artifactId);
      if (!artifact || canonicalJson(artifact.value) !== canonicalJson(entry.result)) throw new TypeError("Legacy tool result artifact mismatch");
    }
    if (entry.kind === "approval_requested") {
      const artifact = entry.artifactId && artifacts.get(entry.artifactId);
      if ((entry.artifactId === undefined) !== (entry.proposalDigest === undefined) || entry.artifactId && (!artifact || computeProposalDigest(artifact.value) !== entry.proposalDigest)) throw new TypeError("Incomplete legacy proposal artifact");
    }
  }
  for (const [runId, runEntries] of runs) {
    const head = runEntries[0];
    const terminal = runEntries.some(entry => (entry.kind === "run_completed" || entry.kind === "run_failed") && entry.runId === runId);
    const calls = runEntries.flatMap(entry => entry.kind === "assistant_message" ? entry.toolCalls ?? [] : []);
    for (const entry of runEntries) if (entry.kind === "approval_requested") {
      const call = calls.find(item => item.id === entry.toolCallId);
      if (!call || entry.runId !== runId || entry.argsDigest !== computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }])) throw new TypeError("Unbound legacy approval request");
    }
    if (!terminal) {
      if (head?.kind !== "run_started" || !runEntries.some(entry => entry.kind === "run_state" && entry.runId === runId)) throw new TypeError("Ambiguous active legacy run cursor");
      for (const record of ledger) {
        if (record.runId !== runId || record.event.kind !== "tool_intent") continue;
        const toolCallId = record.event.toolCallId;
        const committed = ledger.some(item => item.runId === runId && item.event.kind === "tool_exec" && item.event.toolCallId === toolCallId);
        if (!committed) throw new TypeError("Uncertain legacy active tool intent requires manual recovery");
      }
      const current = checkpoints.findLast(checkpoint => checkpoint.runId === runId);
      if (!current) throw new TypeError("Active legacy run lacks a checkpoint");
      const cursor = runEntries.findLast(entry => entry.kind === "run_state" && entry.runId === runId);
      if (cursor?.kind !== "run_state" || !cursor.checkpointId || !checkpoints.some(checkpoint => checkpoint.checkpointId === cursor.checkpointId && checkpoint.runId === runId)) throw new TypeError("Invalid active legacy recovery cursor");
      for (const request of runEntries) if (request.kind === "approval_requested") {
        const matched = runEntries.some(entry => entry.kind === "run_awaiting_approval" && entry.toolCallId === request.toolCallId && entry.runId === runId);
        const committed = ledger.some(item => item.runId === runId && item.event.kind === "tool_exec" && item.event.toolCallId === request.toolCallId);
        const resolved = runEntries.some(entry => entry.kind === "approval_resolved" && entry.toolCallId === request.toolCallId && entry.runId === runId);
        if (!matched && !committed && !resolved) throw new TypeError("Unbound active legacy approval");
        if (request.externalStateBinding && (current.externalStateBinding?.scopeId !== request.externalStateBinding.scopeId || current.externalStateBinding.version !== request.externalStateBinding.version) && !committed) throw new TypeError("Active legacy approval version changed");
      }
      for (const entry of runEntries) if (entry.kind === "approval_requested" && entry.externalStateBinding && current.externalStateBinding?.scopeId !== entry.externalStateBinding.scopeId) throw new TypeError("Legacy approval scope differs from active checkpoint");
    }
  }
  return { entries, checkpoints, ledger };
}
