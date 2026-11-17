// tests/technician.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TechnicianActor } from "../src/actors/TechnicianActor.js";

// Map-backed fake ctx.storage with fake alarm methods (no runtime, no
// network). The constructor args are cast structurally so the test file
// needs no internal runtime types.
type CtorArgs = ConstructorParameters<typeof TechnicianActor>;

function makeActor() {
  const map = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage = {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(map.has(key) ? (map.get(key) as T) : undefined);
    },
    put<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    setAlarm(when: number): Promise<void> {
      alarms.push(when);
      return Promise.resolve();
    },
    getAlarm(): Promise<number | null> {
      return Promise.resolve(alarms.length ? alarms[alarms.length - 1] : null);
    },
    deleteAlarm(): Promise<void> {
      alarms.length = 0;
      return Promise.resolve();
    },
  };
  const actor = new TechnicianActor(
    { storage } as unknown as CtorArgs[0],
    {} as unknown as CtorArgs[1],
  );
  return { actor, map, alarms };
}

// Mute the structured logger (console.log) for the whole file.
const originalLog = console.log;
before(() => {
  console.log = () => {};
});
after(() => {
  console.log = originalLog;
});

test("reserve ok, then a different call_ref gets busy", async () => {
  const { actor } = makeActor();
  const r1 = await actor.reserve({ call_ref: "c1", job_id: "j1" });
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.ok(r1.expires_at > Date.now() + 80_000 && r1.expires_at <= Date.now() + 90_000);
  }
  const r2 = await actor.reserve({ call_ref: "c2", job_id: "j2" });
  assert.deepEqual(r2, { ok: false, reason: "busy" });
});

test("reserve with the same call_ref is idempotent (same expires_at, no write)", async () => {
  const { actor, alarms } = makeActor();
  const r1 = await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 30 });
  assert.equal(r1.ok, true);
  const r2 = await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 30 });
  assert.deepEqual(r2, r1);
  assert.equal(alarms.length, 1, "no second setAlarm on the idempotent replay");
});

test("release succeeds only with matching call_ref and job_id", async () => {
  const { actor } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1" });
  assert.deepEqual(await actor.release({ call_ref: "c1", job_id: "j1" }), { released: true });
  assert.deepEqual(await actor.release({ call_ref: "c1", job_id: "j1" }), { released: false });
  await actor.reserve({ call_ref: "c2", job_id: "j2" });
  assert.deepEqual(await actor.release({ call_ref: "c2", job_id: "wrong" }), { released: false });
  assert.deepEqual(await actor.release({ call_ref: "wrong", job_id: "j2" }), { released: false });
});

test("a hold expires: status is available and alarm() is idempotent", async () => {
  const { actor } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 1 });
  await new Promise((r) => setTimeout(r, 1100));
  const s = await actor.status();
  assert.equal(s.status, "available");
  assert.equal(s.held_for, undefined);
  await actor.alarm();
  await actor.alarm();
  const s2 = await actor.status();
  assert.equal(s2.status, "available");
  assert.equal(s2.held_for, undefined);
  assert.equal((await actor.reserve({ call_ref: "c2", job_id: "j2" })).ok, true);
});

test("off_shift blocks reserve; setShift(true) re-enables it", async () => {
  const { actor } = makeActor();
  const off = await actor.setShift(false);
  assert.equal(off.status, "off_shift");
  assert.deepEqual(await actor.reserve({ call_ref: "c1", job_id: "j1" }), { ok: false, reason: "off_shift" });
  const on = await actor.setShift(true);
  assert.equal(on.status, "available");
  assert.equal((await actor.reserve({ call_ref: "c1", job_id: "j1" })).ok, true);
});

test("invalid reserve inputs are rejected", async () => {
  const { actor } = makeActor();
  assert.deepEqual(await actor.reserve({ call_ref: "", job_id: "j1" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.reserve({ call_ref: "c1", job_id: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 0 }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 601 }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 1.5 }), { ok: false, reason: "invalid_input" });
});
