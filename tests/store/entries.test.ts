import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "../../src/tool-types";
import type { NormalizedError } from "../../src/errors";
import type { ProjectFactsDigest } from "../../src/runtime/context-manager";
import {
  isAgentSessionEntry,
  parseAgentSessionEntry,
  serializeAgentSessionEntry,
} from "../../src/store/entries";
import type { AgentSessionEntry } from "../../src/store/entries";

const error: NormalizedError = { category: "tool_failure", message: "nope", retryable: false };
const result: AgentToolResult = { success: true, message: "ok", data: { nested: [1, "x", null] }, undoable: true };
const digest: ProjectFactsDigest = { projectId: "project-1", projectRevision: 2, digest: "digest", summary: "summary", producedBy: "host" };

const entries: AgentSessionEntry[] = [
  { kind: "user_message", id: "e1", ts: 0, content: "hello" },
  { kind: "assistant_message", id: "e2", ts: 1.5, content: "hi", toolCalls: [{ id: "call-1", type: "function", function: { name: "search", arguments: "{}" } }], usage: { promptTokens: 1, cost: 0.25 } },
  { kind: "tool_call", id: "e3", ts: 2, toolCallId: "call-1", name: "search", argsDigest: "args" },
  { kind: "tool_result", id: "e4", ts: 3, toolCallId: "call-1", result, artifactId: "artifact-1" },
  { kind: "approval_requested", id: "e5", ts: 4, toolCallId: "call-1", reason: "destructive" },
  { kind: "approval_resolved", id: "e6", ts: 5, toolCallId: "call-1", decision: "allow", by: "policy" },
  { kind: "proposal", id: "e18", ts: 16, toolCallId: "call-1", proposalDigest: "proposal-digest", artifactId: "proposal-artifact" },
  { kind: "compaction", id: "e7", ts: 6, summary: "summary", compactedEntryIds: ["e1", "e2"], projectDigest: digest },
  { kind: "checkpoint", id: "e8", ts: 7, checkpointId: "cp-1", projectRevision: 3 },
  { kind: "branch", id: "e9", ts: 8, fromCheckpointId: "cp-1", branchId: "branch-1" },
  { kind: "run_started", id: "e10", ts: 9, runId: "run-1", parentRunId: "run-0" },
  { kind: "run_interrupted", id: "e11", ts: 10, runId: "run-1", cause: "interrupted", lastDurableBoundary: "cp-1" },
  { kind: "run_awaiting_approval", id: "e12", ts: 11, runId: "run-1", toolCallId: "call-1" },
  { kind: "run_completed", id: "e13", ts: 12, runId: "run-1" },
  { kind: "run_failed", id: "e14", ts: 13, runId: "run-1", error },
  { kind: "error", id: "e15", ts: 14, error },
  { kind: "usage", id: "e16", ts: 15, runId: "run-1", usage: { totalTokens: 3 } },
  { kind: "run_state", id: "e17", ts: 16, runId: "run-1", seq: 42, iteration: 3, phase: "tools", activeRoleId: "editor", checkpointId: "cp-1" },
];

describe("session entries", () => {
  test("roundtrips every entry kind", () => {
    for (const entry of entries) {
      expect(isAgentSessionEntry(entry)).toBe(true);
      expect(parseAgentSessionEntry(serializeAgentSessionEntry(entry))).toEqual(entry);
    }
  });

  test("removes opaque error causes before persistence", () => {
    const cause = { apiKey: "secret", nested: { credential: "also-secret" } };
    const entry: AgentSessionEntry = { kind: "error", id: "err", ts: 1, error: { ...error, cause } };
    const serialized = serializeAgentSessionEntry(entry);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("credential");
    expect(parseAgentSessionEntry(serialized)).toEqual({ kind: "error", id: "err", ts: 1, error });
  });

  test("changing proxy discriminators cannot bypass opaque cause removal", () => {
    let kindReads = 0;
    const entry = new Proxy({ kind: "error", id: "e", ts: 0, error: { ...error, cause: { apiKey: "secret" } } }, {
      get(target, key, receiver) {
        if (key === "kind") return ++kindReads === 3 ? "error" : "user_message";
        return Reflect.get(target, key, receiver);
      },
    }) as AgentSessionEntry;
    const serialized = serializeAgentSessionEntry(entry);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("cause");
    expect(parseAgentSessionEntry(serialized)).toEqual({ kind: "error", id: "e", ts: 0, error });
  });

  test("rejects persisted opaque causes and unknown fields", () => {
    expect(() => parseAgentSessionEntry(JSON.stringify({ ...entries[0], extra: true }))).toThrow();
    expect(() => parseAgentSessionEntry(JSON.stringify({ ...entries[14], error: { ...error, cause: "secret" } }))).toThrow();
    expect(isAgentSessionEntry({ ...entries[0], ts: -1 })).toBe(false);
    expect(isAgentSessionEntry({ ...entries[0], kind: "wat" })).toBe(false);
    expect(isAgentSessionEntry({ ...entries[0], id: Object.create({ value: "inherited" }) })).toBe(false);
  });

  test.each([
    { seq: 0 }, { seq: -1 }, { seq: 0.5 }, { iteration: -1 }, { iteration: 0.5 },
    { phase: "unknown" }, { activeRoleId: "" }, { runId: "" }, { checkpointId: "" },
  ])("rejects corrupt durable run cursors: %j", changes => {
    expect(isAgentSessionEntry({ ...entries.find(entry => entry.kind === "run_state")!, ...changes })).toBe(false);
  });

  test("exotic array prototypes are rejected consistently by guards and persistence", () => {
    const calls = Object.setPrototypeOf([{ id: "call", type: "function", function: { name: "seek", arguments: "{}" } }],
      Object.create(Array.prototype));
    const entry: AgentSessionEntry = { kind: "assistant_message", id: "a", ts: 0, content: "", toolCalls: calls };
    expect(isAgentSessionEntry(entry)).toBe(false);
    expect(() => serializeAgentSessionEntry(entry)).toThrow();
  });

  test("synthetic array lengths cannot hide invalid tool-call elements", () => {
    const calls = new Proxy([{}], { get(target, key, receiver) {
      return key === "length" ? NaN : Reflect.get(target, key, receiver);
    } });
    const entry = { kind: "assistant_message", id: "a", ts: 0, content: "", toolCalls: calls } as AgentSessionEntry;
    expect(isAgentSessionEntry(entry)).toBe(false);
    expect(() => serializeAgentSessionEntry(entry)).toThrow();
  });

  test("rejects getters, cycles, and unsupported nested data without throwing", () => {
    const getter = {} as Record<string, unknown>;
    Object.defineProperty(getter, "content", { get() { throw new Error("must not run"); }, enumerable: true });
    expect(isAgentSessionEntry({ ...entries[0], content: getter })).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isAgentSessionEntry({ ...entries[3], result: { success: true, message: "x", data: cycle } })).toBe(false);
    expect(isAgentSessionEntry({ ...entries[3], result: { success: true, message: "x", data: { date: new Date() } } })).toBe(false);
  });
});
