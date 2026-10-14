import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDBStores } from "../../src/adapters/indexeddb";
import { AGENT_STORE_SCHEMA_VERSION } from "../../src/store/schema-migration";
import { computeContextDigest } from "../../src/store/checkpoint";

const definitions = {
  sessions: { keyPath: "sessionId" },
  entries: { keyPath: ["sessionId", "id"], indexes: [["session", "sessionId", false], ["order", ["sessionId", "position"], true]] },
  checkpoints: { keyPath: "checkpointId", indexes: [["session", "sessionId", false], ["order", ["sessionId", "position"], true]] },
  artifactSessions: { keyPath: "sessionId" },
  artifacts: { keyPath: "artifactId", indexes: [["session", "sessionId", false], ["order", ["sessionId", "position"], true]] },
  runs: { keyPath: "runId" },
  ledger: { keyPath: ["runId", "seq"], indexes: [["run", "runId", false]] },
  claims: { keyPath: "toolCallId" },
} as const;

function open(factory: IDBFactory, version: number): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = factory.open("rimecut-agent-v1", version);
  request.onupgradeneeded = event => {
    if (event.oldVersion !== 0) return;
    for (const [name, definition] of Object.entries(definitions)) {
      const keyPath: string | string[] = Array.isArray(definition.keyPath) ? [...definition.keyPath] : definition.keyPath as string;
      const store = request.result.createObjectStore(name, { keyPath });
      if ("indexes" in definition) for (const [index, path, unique] of definition.indexes) {
        const keyPath: string | string[] = Array.isArray(path) ? [...path] : path as string;
        store.createIndex(index, keyPath, { unique });
      }
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

async function seed(factory: IDBFactory, tamper = false) {
  const database = await open(factory, 1);
  const entries = [
    { kind: "run_started", id: "start", ts: 0, runId: "terminal" },
    { kind: "user_message", id: "user", ts: 0, content: "Hello" },
    { kind: "run_completed", id: "end", ts: 0, runId: "terminal" },
  ];
  const transaction = database.transaction(["sessions", "entries", "checkpoints"], "readwrite");
  transaction.objectStore("sessions").put({ sessionId: "session", entryCount: entries.length, checkpointCount: 1 });
  entries.forEach((entry, position) => transaction.objectStore("entries").put({ sessionId: "session", id: entry.id, position, json: JSON.stringify(entry) }));
  transaction.objectStore("checkpoints").put({ checkpointId: "checkpoint", sessionId: "session", position: 0,
    value: { checkpointId: "checkpoint", sessionId: "session", createdAt: 0, entrySeq: 2, runId: "terminal", seq: 1,
      contextDigest: tamper ? "tampered" : computeContextDigest([{ id: "user", createdAt: 0, role: "user", content: "Hello" }]),
      projectId: "repository", projectRevision: 7 } });
  const completed = Promise.withResolvers<void>();
  transaction.oncomplete = () => completed.resolve();
  transaction.onabort = () => completed.reject(transaction.error);
  await completed.promise;
  database.close();
}

for (const tamper of [false, true]) test(`IndexedDB schema-2 ${tamper ? "rolls back tampered" : "upgrades valid"} legacy history without deleting old rows`, async () => {
  const factory = new IDBFactory();
  await seed(factory, tamper);
  if (tamper) {
    await expect(createIndexedDBStores({ indexedDB: factory, name: "rimecut-agent-v1" })).rejects.toThrow();
    const old = await open(factory, 1);
    expect(old.version).toBe(1);
    expect(old.objectStoreNames.contains("legacyBackup")).toBe(false);
    old.close();
    return;
  }
  const stores = await createIndexedDBStores({ indexedDB: factory, name: "rimecut-agent-v1" });
  expect(AGENT_STORE_SCHEMA_VERSION).toBe(2);
  expect((await stores.sessionStore.listCheckpoints("session"))[0]?.externalStateBinding).toEqual({ scopeId: "repository", version: "7" });
  expect((await stores.sessionStore.load("session"))?.entries).toHaveLength(3);
  stores.close();
  const reopened = await createIndexedDBStores({ indexedDB: factory, name: "rimecut-agent-v1" });
  expect((await reopened.sessionStore.listCheckpoints("session"))[0]?.externalStateBinding?.version).toBe("7");
  reopened.close();
  const database = await open(factory, 2);
  const request = database.transaction("legacyBackup", "readonly").objectStore("legacyBackup").getAll();
  const originalResult = Promise.withResolvers<unknown[]>();
  request.onsuccess = () => originalResult.resolve(request.result);
  request.onerror = () => originalResult.reject(request.error);
  const original = await originalResult.promise;
  expect(original).toHaveLength(5);
  database.close();
});

test("migrates a verified legacy awaiting approval with unchanged run and call IDs", async () => {
  const factory = new IDBFactory();
  const database = await open(factory, 1);
  const call = { id: "pending-call", type: "function" as const, function: { name: "write", arguments: "{}" } };
  const argsDigest = computeContextDigest([{ id: "digest", createdAt: 0, role: "assistant", content: "", toolCalls: [call] }]);
  const entries = [
    { kind: "run_started", id: "start", ts: 0, runId: "pending-run" },
    { kind: "user_message", id: "user", ts: 0, content: "write" },
    { kind: "assistant_message", id: "assistant", ts: 0, content: "", toolCalls: [call] },
    { kind: "approval_requested", id: "request", ts: 0, toolCallId: call.id, reason: "Review", runId: "pending-run", argsDigest, projectId: "repo", projectRevision: 3 },
    { kind: "run_awaiting_approval", id: "waiting", ts: 0, runId: "pending-run", toolCallId: call.id },
    { kind: "run_state", id: "cursor", ts: 0, runId: "pending-run", seq: 4, iteration: 0, phase: "tools", activeRoleId: "general", checkpointId: "checkpoint" },
  ];
  const tx = database.transaction(["sessions", "entries", "checkpoints"], "readwrite");
  tx.objectStore("sessions").put({ sessionId: "session", entryCount: entries.length, checkpointCount: 1 });
  entries.forEach((entry, position) => tx.objectStore("entries").add({ sessionId: "session", id: entry.id, position, json: JSON.stringify(entry) }));
  tx.objectStore("checkpoints").add({ checkpointId: "checkpoint", sessionId: "session", position: 0,
    value: { checkpointId: "checkpoint", sessionId: "session", runId: "pending-run", seq: 3, createdAt: 0, entrySeq: 5,
      contextDigest: computeContextDigest([{ id: "user", role: "user", content: "write", createdAt: 0 }, { id: "assistant", role: "assistant", content: "", toolCalls: [call], createdAt: 0 }]),
      projectId: "repo", projectRevision: 3 } });
  const committed = Promise.withResolvers<void>();
  tx.oncomplete = () => committed.resolve();
  tx.onabort = () => committed.reject(tx.error);
  await committed.promise;
  database.close();
  const stores = await createIndexedDBStores({ indexedDB: factory, name: "rimecut-agent-v1" });
  const converted = (await stores.sessionStore.load("session"))!.entries;
  expect(converted.find(entry => entry.kind === "approval_requested")).toMatchObject({ runId: "pending-run", toolCallId: "pending-call", externalStateBinding: { scopeId: "repo", version: "3" } });
  stores.close();
  const reopened = await createIndexedDBStores({ indexedDB: factory, name: "rimecut-agent-v1" });
  expect((await reopened.sessionStore.load("session"))!.entries.find(entry => entry.kind === "run_state")).toMatchObject({ runId: "pending-run", checkpointId: "checkpoint" });
  reopened.close();
});

test("rejects unexpected legacy object-store indexes before copying any row", async () => {
  const factory = new IDBFactory();
  const ready = Promise.withResolvers<IDBDatabase>();
  const opening = factory.open("invalid-index", 1);
  opening.onupgradeneeded = () => {
    for (const [name, definition] of Object.entries(definitions)) {
      const keyPath: string | string[] = Array.isArray(definition.keyPath) ? [...definition.keyPath] : definition.keyPath as string;
      const store = opening.result.createObjectStore(name, { keyPath });
      if ("indexes" in definition) for (const [index, path, unique] of definition.indexes) {
        const keyPath: string | string[] = Array.isArray(path) ? [...path] : path as string;
        store.createIndex(index, keyPath, { unique });
      }
      if (name === "entries") store.createIndex("extra", "id");
    }
  };
  opening.onsuccess = () => ready.resolve(opening.result);
  opening.onerror = () => ready.reject(opening.error);
  (await ready.promise).close();
  await expect(createIndexedDBStores({ indexedDB: factory, name: "invalid-index" })).rejects.toThrow("Unsupported IndexedDB");
  const old = factory.open("invalid-index", 1);
  const reopened = Promise.withResolvers<IDBDatabase>();
  old.onsuccess = () => reopened.resolve(old.result);
  old.onerror = () => reopened.reject(old.error);
  expect((await reopened.promise).version).toBe(1);
  old.result.close();
});
