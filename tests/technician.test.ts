// tests/technician.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TechnicianActor } from "../src/actors/TechnicianActor.js";

// Map-backed fake ctx.storage with fake alarm methods (no runtime, no
// network). The constructor args are cast structurally so the test file
// needs no internal runtime types.
type CtorArgs = ConstructorParameters<typeof TechnicianActor>;

function makeActor(env: Record<string, unknown> = {}) {
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
    env as unknown as CtorArgs[1],
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

// D20-2 regression: one technician was reserved for four jobs in 25 minutes.
// While dispatched, every reserve attempt answers busy; after dispatched_until
// the technician lazily returns to available.
test("dispatched: reserve is busy until dispatched_until, then free again", async () => {
  const { actor } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1" });
  const d = await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 1 });
  assert.equal(d.ok, true);
  assert.equal((await actor.status()).status, "dispatched");
  // Four more jobs while dispatched: every one is refused.
  for (const n of [2, 3, 4, 5]) {
    assert.deepEqual(await actor.reserve({ call_ref: `c${n}`, job_id: `j${n}` }), { ok: false, reason: "busy" });
  }
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await actor.status()).status, "available");
  assert.equal((await actor.reserve({ call_ref: "c9", job_id: "j9" })).ok, true);
});

test("dispatch: clears the hold, arms the alarm, busy_s default and env override", async () => {
  const a = makeActor();
  await a.actor.reserve({ call_ref: "c1", job_id: "j1" });
  const before = Date.now();
  const d = await a.actor.dispatch({ call_ref: "c1", job_id: "j1" });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.ok(d.until >= before + 1800_000 && d.until <= Date.now() + 1800_000, "DISPATCH_BUSY_S default 1800");
  }
  const s = await a.actor.status();
  assert.equal(s.status, "dispatched");
  assert.equal(s.held_for, undefined, "dispatch clears the hold");
  assert.equal(s.dispatched_for?.call_ref, "c1");
  assert.equal(a.alarms[a.alarms.length - 1], s.dispatched_for?.until, "alarm armed to until");

  const b = makeActor({ DISPATCH_BUSY_S: "5" });
  const d2 = await b.actor.dispatch({ call_ref: "c1", job_id: "j1" });
  assert.equal(d2.ok, true);
  if (d2.ok) {
    assert.ok(d2.until <= Date.now() + 5_000 && d2.until > Date.now(), "env override wins");
  }
  const bad = makeActor({ DISPATCH_BUSY_S: "0" });
  const d3 = await bad.actor.dispatch({ call_ref: "c1", job_id: "j1" });
  assert.ok(d3.ok && d3.until > Date.now() + 1700_000, "out-of-range env falls back to 1800");
  assert.deepEqual(await a.actor.dispatch({ call_ref: "", job_id: "j1" }), { ok: false, reason: "invalid_input" });
});

test("clearDispatch frees the technician early; setShift(false) clears a dispatch", async () => {
  const { actor, alarms } = makeActor();
  await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 1800 });
  assert.deepEqual(await actor.clearDispatch(), { cleared: true, was: "dispatched" });
  assert.deepEqual(await actor.clearDispatch(), { cleared: false });
  assert.equal((await actor.status()).status, "available");
  assert.equal(alarms.length, 0, "no timer left pending");
  assert.equal((await actor.reserve({ call_ref: "c2", job_id: "j2" })).ok, true);

  await actor.dispatch({ call_ref: "c2", job_id: "j2", busy_s: 1800 });
  const off = await actor.setShift(false);
  assert.equal(off.status, "off_shift");
  assert.equal(off.dispatched_for, undefined);
  assert.deepEqual(await actor.reserve({ call_ref: "c3", job_id: "j3" }), { ok: false, reason: "off_shift" });
});

// T1.6: the admin reset also frees a live hold so the next chat-test repeat
// can reserve; off_shift is never flipped.
test("clearDispatch frees a hold too; off_shift is untouched", async () => {
  const { actor, alarms } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1" });
  assert.equal((await actor.status()).status, "held");
  assert.deepEqual(await actor.clearDispatch(), { cleared: true, was: "held" });
  const s = await actor.status();
  assert.equal(s.status, "available");
  assert.equal(s.held_for, undefined);
  assert.equal(alarms.length, 0, "no timer left pending");
  // A later reserve succeeds.
  assert.equal((await actor.reserve({ call_ref: "c2", job_id: "j2" })).ok, true);

  // off_shift: nothing to clear and the status stays off_shift.
  const off = makeActor();
  await off.actor.reserve({ call_ref: "c1", job_id: "j1" });
  await off.actor.setShift(false);
  assert.deepEqual(await off.actor.clearDispatch(), { cleared: false });
  assert.equal((await off.actor.status()).status, "off_shift");
});

test("extendHold: same call_ref and job_id only; keeps a long ring from lapsing", async () => {
  const { actor, alarms } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 1 });
  await actor.markBooked({ call_ref: "c1", job_id: "j1" });
  assert.deepEqual(await actor.extendHold({ call_ref: "c1", job_id: "wrong", ttl_s: 60 }), { extended: false });
  assert.deepEqual(await actor.extendHold({ call_ref: "wrong", job_id: "j1", ttl_s: 60 }), { extended: false });
  assert.deepEqual(await actor.extendHold({ call_ref: "c1", job_id: "j1", ttl_s: 0 }), { extended: false });
  assert.deepEqual(await actor.extendHold({ call_ref: "c1", job_id: "j1", ttl_s: 60 }), { extended: true });
  assert.equal(alarms[alarms.length - 1], (await actor.status()).held_for?.expires_at, "alarm moved to the new expiry");
  // The original 1 s hold would have lapsed by now; the extension kept it.
  await new Promise((r) => setTimeout(r, 1100));
  const s = await actor.status();
  assert.equal(s.status, "held");
  assert.equal(s.held_for?.booked, true, "booked untouched: no false hold_expired");
});

test("alarm: re-arms to whichever of hold or dispatch expires first; harmless twice", async () => {
  const { actor, alarms } = makeActor();
  // Dispatch clears the hold, so the only pending wake-up is the dispatch end.
  await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 90 });
  await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 1800 });
  alarms.length = 0;
  await actor.alarm();
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0], (await actor.status()).dispatched_for?.until);
  await actor.alarm();
  assert.equal(alarms.length, 2, "idempotent re-arm on repeat delivery");
});

test("tech_dispatch_expired: logged once when the dispatch lapses", async () => {
  const logged: string[] = [];
  const prev = console.log; // the file-wide muted logger
  console.log = (m: unknown) => logged.push(String(m));
  const lapseLines = () =>
    logged
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "tech_dispatch_expired");
  try {
    const a = makeActor();
    await a.actor.dispatch({ call_ref: "dx-1", job_id: "jd-1", busy_s: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    await a.actor.alarm();
    await a.actor.alarm();
    await a.actor.status();
    assert.equal(lapseLines().length, 1, `expected one tech_dispatch_expired, got: ${logged.join("\n")}`);
    assert.equal(lapseLines()[0].call_ref, "dx-1");
    assert.equal((await a.actor.status()).status, "available");
  } finally {
    console.log = prev;
  }
});

// D20-2 follow-up: dispatch is guarded by who holds / occupies the technician.
test("dispatch: held_by_other refuses and never clears the foreign hold", async () => {
  const { actor } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1" });
  assert.deepEqual(
    await actor.dispatch({ call_ref: "c2", job_id: "j2" }),
    { ok: false, reason: "held_by_other" },
  );
  const s = await actor.status();
  assert.equal(s.held_for?.call_ref, "c1", "the foreign hold survives the refusal");
  assert.equal(s.held_for?.job_id, "j1");
  assert.equal(s.dispatched_for, undefined);
  assert.equal(s.status, "held");
  // The holder itself can still dispatch.
  assert.equal((await actor.dispatch({ call_ref: "c1", job_id: "j1" })).ok, true);
});

test("dispatch: busy refuses while another job is dispatched", async () => {
  const { actor } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1" });
  assert.equal((await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 60 })).ok, true);
  assert.deepEqual(
    await actor.dispatch({ call_ref: "c2", job_id: "j2", busy_s: 60 }),
    { ok: false, reason: "busy" },
  );
  const s = await actor.status();
  assert.equal(s.dispatched_for?.job_id, "j1", "the first dispatch is untouched");
});

test("dispatch: idempotent repeat for the same job returns the same until", async () => {
  const { actor, alarms } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1" });
  const d1 = await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 60 });
  assert.equal(d1.ok, true);
  const alarmsAfterFirst = alarms.length;
  const d2 = await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 60 });
  assert.deepEqual(d2, d1, "same until, no re-dispatch");
  assert.equal(alarms.length, alarmsAfterFirst, "repeat does not re-arm");
  assert.equal((await actor.status()).dispatched_for?.until, d1.ok ? d1.until : -1);
});

test("dispatch: succeeds with no hold at all (the hold lapsed mid-ring)", async () => {
  const { actor } = makeActor();
  await actor.reserve({ call_ref: "c1", job_id: "j1", ttl_s: 1 });
  await new Promise((r) => setTimeout(r, 1100));
  const d = await actor.dispatch({ call_ref: "c1", job_id: "j1", busy_s: 60 });
  assert.equal(d.ok, true);
  assert.equal((await actor.status()).status, "dispatched");
});
