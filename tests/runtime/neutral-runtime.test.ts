import { expect, test } from "bun:test";
import { createToolExecutor } from "../../src/runtime/executor";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemorySessionStore } from "../../src/store/session-store";
import { RuntimeHistory } from "../../src/runtime/history";
import { verifiedStateBinding } from "../../src/runtime/recovery";
import type { ToolCall } from "../../src/types";
import type { DurableToolExecution } from "../../src/tool-types";

const call: ToolCall = { id: "opaque-call", type: "function", function: { name: "undo", arguments: "{}" } };
const binding = (version: string) => ({ scopeId: "repo", version });

for (const hasReceipt of [false, true]) test(`committed ${hasReceipt ? "receipted" : "unreceipted"} state transition cannot be adopted by checkpoint`, async () => {
  const ledger = new InMemoryLedger();
  const artifactStore = new InMemoryArtifactStore();
  const sessionStore = new InMemorySessionStore();
  const history = new RuntimeHistory(sessionStore, "session");
  await history.append({ kind: "run_started", runId: "run" });
  await history.append({ kind: "assistant_message", content: "", toolCalls: [call] });
  const original = await history.checkpoint("before", { runId: "run", seq: 1, externalStateBinding: binding("etag-A") });
  let version = "etag-A";
  let executions = 0;
  let sequence = 1;
  const executor = createToolExecutor({ sessionId: "session", ledger, artifactStore, tools: [{
    name: "undo", description: "opaque name", parameters: { type: "object", properties: {} },
    annotations: { readOnly: false, executionMode: "serial" },
    async execute() {
      executions++;
      version = "etag-B";
      return { result: { success: true, message: "done", data: { commandId: 42, projectRevisionBefore: "etag-A" } },
        ...(hasReceipt ? { receipt: { operationId: "committed", stateChange: { before: binding("etag-A"), after: binding("etag-B") } } } : {}) };
    },
  }] });
  const context = { runId: "run", nextSeq: () => ++sequence,
    getHostSnapshot: () => ({ externalStateBinding: binding(version) }), expectedBinding: async () => binding("etag-A") };
  if (!hasReceipt) {
    await expect(executor.execute(call, context)).rejects.toThrow("Host state does not match");
    expect((await ledger.query("run")).filter(record => record.event.kind === "tool_exec")).toHaveLength(0);
  } else {
    const result = await executor.execute(call, context);
    expect(result.data).toEqual({ commandId: 42, projectRevisionBefore: "etag-A" });
    const saved = await artifactStore.list("session");
    expect(saved[0]?.value).toEqual({ success: true, message: "done", data: { commandId: 42, projectRevisionBefore: "etag-A" } });
    expect(JSON.stringify(saved)).not.toContain("committed");
    const checkpoints = await history.checkpoints();
    const expected = await verifiedStateBinding(checkpoints[0]!, "run", await history.entries(), await ledger.query("run"), artifactStore);
    expect(expected).toEqual(binding("etag-B"));
    const next = await history.checkpoint("after", { runId: "run", seq: ++sequence, externalStateBinding: expected });
    expect(next.externalStateBinding).toEqual(binding("etag-B"));
    const allCheckpoints = await history.checkpoints();
    const records = await ledger.query("run");
    expect(await verifiedStateBinding(allCheckpoints[1]!, "run", await history.entries(), records, artifactStore, allCheckpoints)).toEqual(binding("etag-B"));
    const damaged = records.map(record => record.event.kind === "tool_exec" ? { ...record, event: { ...record.event, receipt: { operationId: "committed" } } } : record);
    await expect(verifiedStateBinding(allCheckpoints[1]!, "run", await history.entries(), damaged, artifactStore, allCheckpoints)).rejects.toMatchObject({ category: "tool_failure" });
    const missing = { put: artifactStore.put.bind(artifactStore), list: artifactStore.list.bind(artifactStore), get: async () => null };
    await expect(verifiedStateBinding(allCheckpoints[1]!, "run", await history.entries(), records, missing, allCheckpoints)).rejects.toMatchObject({ category: "tool_failure" });
  }
  expect(executions).toBe(1);
  expect(original.externalStateBinding).toEqual(binding("etag-A"));
  expect((await history.checkpoints())[0]?.externalStateBinding).toEqual(binding("etag-A"));
});

test("fault in tool output after a non-idempotent effect leaves an uncertain intent", async () => {
  const ledger = new InMemoryLedger();
  let executions = 0;
  const executor = createToolExecutor({ sessionId: "session", ledger, artifactStore: new InMemoryArtifactStore(), tools: [{
    name: "undo", description: "effect", parameters: { type: "object", properties: {} }, async execute() {
      executions++;
      const invalid: unknown = { result: { success: true, message: "invalid", undoable: true } };
      return invalid as DurableToolExecution;
    },
  }] });
  let seq = 0;
  await expect(executor.execute(call, { runId: "run", nextSeq: () => ++seq })).rejects.toThrow("invalid durable execution");
  await expect(executor.execute(call, { runId: "run", nextSeq: () => ++seq })).rejects.toMatchObject({ category: "tool_failure" });
  expect(executions).toBe(1);
  expect((await ledger.query("run")).filter(record => record.event.kind === "tool_exec")).toHaveLength(0);
});
