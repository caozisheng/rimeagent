import { test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { InMemorySessionStore } from "../../src/store/session-store";
import { InMemoryArtifactStore } from "../../src/store/artifact-store";
import { InMemoryLedger } from "../../src/runtime/ledger";
import { createIndexedDBStores } from "../../src/adapters/indexeddb";
import { runStoreContract } from "./store-contract";

test("in-memory stores pass shared host contract", async () => {
  await runStoreContract(async () => ({sessionStore:new InMemorySessionStore(),artifactStore:new InMemoryArtifactStore(),ledger:new InMemoryLedger()}));
});

test("IndexedDB stores pass identical host contract", async () => {
  await runStoreContract(() => createIndexedDBStores({name:"contract",indexedDB:new IDBFactory()}));
});
