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

// S1.9 item 5e: a lapsed hold emits exactly one hold_expired line (technician
// id + hold length in latency_ms); booked or still-active holds stay silent.
test("hold_expired: logged once on lapse with hold length; silent when booked or active", async () => {
  const logged: string[] = [];
  const prev = console.log; // the file-wide muted logger
  console.log = (m: unknown) => logged.push(String(m));
  const lapseLines = () =>
    logged
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "hold_expired");
  try {
    // Lapsed, unconsumed hold: exactly one line, even across repeat reads.
    const a = makeActor();
    await a.actor.reserve({ call_ref: "hx-1", job_id: "jh-1", ttl_s: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    await a.actor.alarm();
    await a.actor.alarm();
    await a.actor.status();
    assert.equal(lapseLines().length, 1, `expected one hold_expired, got: ${logged.join("\n")}`);
    assert.equal(lapseLines()[0].technician_id, "tech");
    assert.equal(lapseLines()[0].latency_ms, 1000, "hold length in latency_ms");

    // Booked (consumed by create_job): the sweep clears silently.
    logged.length = 0;
    const b = makeActor();
    await b.actor.reserve({ call_ref: "hx-2", job_id: "jh-2", ttl_s: 1 });
    assert.deepEqual(await b.actor.markBooked({ call_ref: "hx-2", job_id: "jh-2" }), { booked: true });
    await new Promise((r) => setTimeout(r, 1100));
    await b.actor.alarm();
    assert.equal(lapseLines().length, 0);
    assert.equal((await b.actor.status()).status, "available");

    // Still-active hold: the alarm only re-arms.
    logged.length = 0;
    const c = makeActor();
    await c.actor.reserve({ call_ref: "hx-3", job_id: "jh-3", ttl_s: 30 });
    await c.actor.alarm();
    assert.equal(lapseLines().length, 0);
    assert.equal((await c.actor.status()).status, "held");
  } finally {
    console.log = prev;
  }
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
