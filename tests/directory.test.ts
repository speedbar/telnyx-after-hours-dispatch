// tests/directory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectoryActor } from "../src/actors/DirectoryActor.js";

// Build a DirectoryActor against a Map-backed fake ctx.storage (no runtime,
// no network). The constructor args are cast structurally so the test file
// needs no internal runtime types.
type CtorArgs = ConstructorParameters<typeof DirectoryActor>;

function makeActor(map: Map<string, unknown>): DirectoryActor {
  const storage = {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(map.has(key) ? (map.get(key) as T) : undefined);
    },
    put<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
  };
  return new DirectoryActor(
    { storage } as unknown as CtorArgs[0],
    {} as unknown as CtorArgs[1],
  );
}

test("lookup returns the flag and customer strings for a known number", async () => {
  const map = new Map<string, unknown>([
    ["flag/dispatch_enabled", "true"],
    ["cust/61491570006", '{"name":"Ada"}'],
  ]);
  const actor = makeActor(map);
  const res = await actor.lookup("61491570006", "dispatch_enabled");
  assert.deepEqual(res, { flag: "true", customer: '{"name":"Ada"}' });
});

test("lookup returns nulls when the keys are missing", async () => {
  const actor = makeActor(new Map());
  const res = await actor.lookup("61491570006", "dispatch_enabled");
  assert.deepEqual(res, { flag: null, customer: null });
});

test("lookup does not parse the customer record (raw string out)", async () => {
  const map = new Map<string, unknown>([
    ["flag/dispatch_enabled", "false"],
    ["cust/61491570006", "not json at all"],
  ]);
  const actor = makeActor(map);
  const res = await actor.lookup("61491570006", "dispatch_enabled");
  assert.equal(res.flag, "false");
  assert.equal(res.customer, "not json at all");
});

test("flag returns the stored string, and null when missing", async () => {
  const map = new Map<string, unknown>([["flag/dispatch_enabled", "true"]]);
  const actor = makeActor(map);
  assert.equal(await actor.flag("dispatch_enabled"), "true");
  assert.equal(await actor.flag("other_flag"), null);
});

test("seed stores every entry and returns the count", async () => {
  const map = new Map<string, unknown>();
  const actor = makeActor(map);
  const count = await actor.seed([
    { key: "flag/dispatch_enabled", value: "false" },
    { key: "cust/61491570006", value: "{}" },
  ]);
  assert.equal(count, 2);
  assert.equal(map.get("flag/dispatch_enabled"), "false");
  assert.equal(map.get("cust/61491570006"), "{}");
});

test("seed rejects an invalid key before writing anything", async () => {
  const map = new Map<string, unknown>();
  const actor = makeActor(map);
  await assert.rejects(
    actor.seed([
      { key: "flag/dispatch_enabled", value: "true" },
      { key: "bad key with spaces", value: "x" },
    ]),
    /invalid_kv_key/,
  );
  assert.equal(map.size, 0, "no entry may be written when any key is invalid");
});
