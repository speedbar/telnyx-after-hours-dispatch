// tests/job.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JobActor } from "../src/actors/JobActor.js";

// Map-backed fake ctx.storage; get() returns a structuredClone so tests mimic
// the runtime (no shared object references). The fake ctx has no id, so
// call_ref falls back to "call". Supports the alarm API (setAlarm/getAlarm/
// deleteAlarm/delete) like the real Stateful Actor storage.
type CtorArgs = ConstructorParameters<typeof JobActor>;

function makeActor(env: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let deleteCount = 0;
  const storage = {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(
        map.has(key) ? (structuredClone(map.get(key)) as T) : undefined,
      );
    },
    put<T>(key: string, value: T): Promise<void> {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      if (map.has(key)) {
        deleteCount++;
        map.delete(key);
      }
      return Promise.resolve();
    },
    setAlarm: (when: number) => {
      alarmAt = when;
      return Promise.resolve();
    },
    getAlarm: () => Promise.resolve(alarmAt),
    deleteAlarm: () => {
      alarmAt = null;
      return Promise.resolve();
    },
  };
  const actor = new JobActor(
    { storage } as unknown as CtorArgs[0],
    env as unknown as CtorArgs[1],
  );
  return { actor, map, alarm: () => alarmAt, deleteCount: () => deleteCount };
}

// D20-5b: a DirectoryActor-shaped fake with a counting daily cap; flag is
// what flag("ring_mode") returns (null = unset -> dry_run, fail safe).
function dirEnv(flag: string | null, extra: Record<string, unknown> = {}) {
  const bumps: string[] = [];
  const env = {
    DIRECTORY: {
      idFromName: () => ({
        flag: async () => flag,
        bumpCounter: async () => {
          bumps.push("ring");
          return { ok: true, count: 1 };
        },
      }),
    },
    ...extra,
  };
  return { env, bumps };
}

// Capture log lines for the duration of fn, then restore the file-wide mute.
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const prior = console.log;
  console.log = (m: unknown) => {
    lines.push(String(m));
  };
  try {
    await fn();
  } finally {
    console.log = prior;
  }
  return lines;
}

// Mute the structured logger (console.log) for the whole file.
const originalLog = console.log;
before(() => {
  console.log = () => {};
});
after(() => {
  console.log = originalLog;
});

const openArgs = {
  job_id: "j1",
  tech_id: "tech-01",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Brunswick",
  summary: "burst pipe",
};
const briefArgs = {
  job_id: "j1",
  customer_name: "Ada",
  address: "1 Smith St",
  contact_phone: "+61491570006",
  details: "water through the ceiling",
  hazards: "power near the leak",
};

test("open creates (created true) then replays (created false, no write)", async () => {
  const { actor, map } = makeActor();
  assert.deepEqual(await actor.open(openArgs), { ok: true, state: "reserved", created: true });
  const stored = structuredClone(map.get("job"));
  assert.deepEqual(await actor.open(openArgs), { ok: true, state: "reserved", created: false });
  assert.deepEqual(map.get("job"), stored, "replay must not rewrite the record");
});

test("open with a different job_id is job_mismatch", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  assert.deepEqual(await actor.open({ ...openArgs, job_id: "j2" }), { ok: false, reason: "job_mismatch" });
});

test("brief before open is no_active_reservation; brief ok then replay ok", async () => {
  const { actor } = makeActor();
  assert.deepEqual(await actor.brief(briefArgs), { ok: false, reason: "no_active_reservation" });
  await actor.open(openArgs);
  assert.deepEqual(await actor.brief(briefArgs), { ok: true, state: "briefed" });
  assert.deepEqual(await actor.brief(briefArgs), { ok: true, state: "briefed" });
  const rec = await actor.get();
  assert.equal(rec?.state, "briefed");
  assert.equal(rec?.customer_name, "Ada");
  assert.equal(rec?.hazards, "power near the leak");
});

test("brief with a wrong job_id is no_active_reservation", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  assert.deepEqual(await actor.brief({ ...briefArgs, job_id: "j2" }), { ok: false, reason: "no_active_reservation" });
});

test("release true, then false on replay; false for a wrong job_id", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  assert.deepEqual(await actor.release({ job_id: "j2", reason: "x" }), { released: false });
  assert.deepEqual(await actor.release({ job_id: "j1", reason: "job done" }), { released: true });
  assert.deepEqual(await actor.release({ job_id: "j1", reason: "job done" }), { released: false });
});

// S1.8 3b: the callback confirmed at reservation wins over a brief value.
test("brief keeps the contact_phone stored at open (first confirmed wins)", async () => {
  const { actor } = makeActor();
  await actor.open({ ...openArgs, contact_phone: "61411111111" });
  assert.deepEqual(await actor.brief({ ...briefArgs, contact_phone: "61422222222" }), { ok: true, state: "briefed" });
  const rec = await actor.get();
  assert.equal(rec?.contact_phone, "61411111111");
});

test("after release: brief is no_active_reservation, open is already_closed", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  await actor.release({ job_id: "j1", reason: "job done" });
  assert.deepEqual(await actor.brief(briefArgs), { ok: false, reason: "no_active_reservation" });
  assert.deepEqual(await actor.open(openArgs), { ok: false, reason: "already_closed" });
});

test("get returns null on an empty actor", async () => {
  const { actor } = makeActor();
  assert.equal(await actor.get(), null);
});

// S1.8: open keeps the confirmed caller details and the flags; open also
// arms the retention alarm; the alarm deletes once and is idempotent.
test("open stores flags and caller details, sets a retention alarm, alarm deletes once", async () => {
  const { actor, map, alarm, deleteCount } = makeActor();
  const before = Date.now();
  const r = await actor.open({
    ...openArgs,
    flags: ["address_no_house_number"],
    customer_name: "Ada",
    address: "1 Smith St",
    contact_phone: "61491570006",
  });
  assert.equal(r.ok, true);
  const rec = await actor.get();
  assert.deepEqual(rec?.flags, ["address_no_house_number"]);
  assert.equal(rec?.customer_name, "Ada");
  assert.equal(rec?.contact_phone, "61491570006");
  const at = alarm();
  assert.ok(at !== null && at >= before + 6 * 86_400_000 && at <= Date.now() + 8 * 86_400_000, "retention alarm about 7 days out");
  // Retention comes due: the alarm deletes exactly once; a repeat is a no-op.
  map.set("job", { ...(map.get("job") as Record<string, unknown>), retention_at: Date.now() - 1 });
  await actor.alarm();
  assert.equal(await actor.get(), null);
  assert.equal(deleteCount(), 1);
  // At-least-once delivery: a second alarm must not throw and must not delete again.
  await actor.alarm();
  assert.equal(deleteCount(), 1);
});

test("invalid inputs are rejected for open and brief", async () => {
  const { actor } = makeActor();
  assert.deepEqual(await actor.open({ ...openArgs, job_id: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.open({ ...openArgs, tech_id: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.open({ ...openArgs, summary: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.open({ ...openArgs, urgency: 3 as unknown as string }), { ok: false, reason: "invalid_input" });
  await actor.open(openArgs);
  assert.deepEqual(await actor.brief({ ...briefArgs, customer_name: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.brief({ ...briefArgs, address: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.brief({ ...briefArgs, details: "" }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.brief({ ...briefArgs, contact_phone: 5 as unknown as string }), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await actor.brief({ ...briefArgs, hazards: null as unknown as string }), { ok: false, reason: "invalid_input" });
});

// D20-2: the alarm is multiplexed between the ring start and retention. A due
// ring start is consumed and never deletes the job; only a due retention does.
test("multiplexed alarm: ring due consumes ring_at, job kept, re-armed to retention", async () => {
  const { actor, alarm, deleteCount } = makeActor();
  await actor.open(openArgs);
  const ringAt = Date.now() + 10;
  assert.deepEqual(await actor.setRingAt(ringAt), { ok: true });
  assert.equal(alarm(), ringAt, "alarm moved up to the ring start");
  await new Promise((r) => setTimeout(r, 20));
  await actor.alarm();
  const rec = await actor.get();
  assert.ok(rec !== null, "the ring alarm must not delete the job");
  assert.equal(rec?.ring_at, undefined, "ring_at consumed");
  assert.equal(deleteCount(), 0);
  const at = alarm();
  assert.ok(at !== null && at >= Date.now() + 6 * 86_400_000, "re-armed to retention");
  // A repeat delivery with nothing due is a harmless no-op.
  await actor.alarm();
  assert.equal(deleteCount(), 0);
  assert.ok((await actor.get()) !== null);
});

test("multiplexed alarm: nothing deletes before retention is due", async () => {
  const { actor, deleteCount } = makeActor();
  await actor.open(openArgs);
  await actor.alarm();
  assert.equal(await actor.get() === null, false);
  assert.equal(deleteCount(), 0);
});

test("setRingAt on an empty actor or with a bad time is rejected", async () => {
  const { actor } = makeActor();
  assert.deepEqual(await actor.setRingAt(Date.now()), { ok: false });
  await actor.open(openArgs);
  assert.deepEqual(await actor.setRingAt(NaN), { ok: false });
});

// D20-2: ringEvent runs the reducer in one read-modify-write: the ring state
// and any job_state effect (dispatch_state) are stored together.
test("ringEvent stores the ring state and applies dispatch_state; JobState unchanged", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  const r1 = await actor.ringEvent({ type: "start", mode: "live", candidates: ["tech-01"], now: 1000 });
  assert.equal(r1.state?.status, "dialing");
  assert.equal((await actor.get())?.ring?.status, "dialing");
  await actor.ringEvent({ type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  const r3 = await actor.ringEvent({ type: "answered", call_control_id: "cc1", event_id: "e1", now: 1002 });
  assert.equal(r3.state?.status, "prompting");
  const r4 = await actor.ringEvent({ type: "gather", call_control_id: "cc1", digits: "1", event_id: "e2", now: 1003 });
  assert.equal(r4.state?.status, "accepted");
  assert.ok(r4.effects.some((e) => e.type === "job_state" && e.state === "dispatched"));
  const rec = await actor.get();
  assert.equal(rec?.dispatch_state, "dispatched");
  assert.equal(rec?.state, "reserved", "JobState untouched by the ring");
});

test("ringEvent is idempotent for a duplicate event id", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  await actor.ringEvent({ type: "start", mode: "live", candidates: ["tech-01"], now: 1000 });
  await actor.ringEvent({ type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  const r1 = await actor.ringEvent({ type: "answered", call_control_id: "cc1", event_id: "e1", now: 1002 });
  const before = (await actor.get())?.ring;
  const r2 = await actor.ringEvent({ type: "answered", call_control_id: "cc1", event_id: "e1", now: 2000 });
  assert.deepEqual(r2.effects, [{ type: "log", event: "ring_dup_event" }]);
  assert.equal(r2.state?.status, r1.state?.status);
  assert.deepEqual((await actor.get())?.ring, before, "stored ring state untouched");
});

test("ringEvent on an empty actor is a safe no-op", async () => {
  const { actor } = makeActor();
  assert.deepEqual(
    await actor.ringEvent({ type: "start", mode: "live", candidates: ["t1"], now: 0 }),
    { state: null, effects: [] },
  );
});

// D20-2 follow-up: an in-flight attempt marks dispatch_state "ringing" when
// the reducer emits no job_state effect; a job_state effect still wins.
test("ringEvent marks dispatch_state ringing while dialing and prompting", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  const r1 = await actor.ringEvent({ type: "start", mode: "live", candidates: ["tech-01"], now: 1000 });
  assert.equal(r1.state?.status, "dialing");
  assert.equal((await actor.get())?.dispatch_state, "ringing");
  await actor.ringEvent({ type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  const r2 = await actor.ringEvent({ type: "answered", call_control_id: "cc1", event_id: "e1", now: 1002 });
  assert.equal(r2.state?.status, "prompting");
  assert.equal((await actor.get())?.dispatch_state, "ringing");
  // The accept emits job_state dispatched: it wins over the ringing default.
  const r3 = await actor.ringEvent({ type: "gather", call_control_id: "cc1", digits: "1", event_id: "e2", now: 1003 });
  assert.equal(r3.state?.status, "accepted");
  assert.equal((await actor.get())?.dispatch_state, "dispatched");
});

test("ringEvent marks dispatch_state ringing through an escalation (reserving)", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  await actor.ringEvent({ type: "start", mode: "live", candidates: ["t1", "t2"], now: 1000 });
  await actor.ringEvent({ type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  await actor.ringEvent({ type: "answered", call_control_id: "cc1", event_id: "e1", now: 1002 });
  const r = await actor.ringEvent({ type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1003 });
  assert.equal(r.state?.status, "reserving");
  assert.equal((await actor.get())?.dispatch_state, "ringing");
});

// D20-5b: a due ring_at now runs startRing from the alarm. ring_at is
// consumed first, so a redelivery starts nothing; unset flag = dry_run, which
// logs and dials nothing.
test("alarm with a due ring_at runs startRing once; redelivery is a no-op (dry_run)", async () => {
  const { env, bumps } = dirEnv(null);
  const { actor, deleteCount } = makeActor(env);
  await actor.open(openArgs);
  await actor.setRingAt(Date.now() - 1);
  const lines = await captureLogs(() => actor.alarm());
  const rec = await actor.get();
  assert.ok(rec !== null, "a ring alarm never deletes the job");
  assert.equal(rec?.ring_at, undefined, "ring_at consumed");
  assert.equal(rec?.ring?.status, "dry_run", "one dry-run start was fed");
  assert.equal(rec?.ring_start_reason, "ok");
  assert.equal(typeof rec?.ring_alarm_ran_at, "number");
  assert.equal(rec?.dispatch_state, undefined, "a dry_run start leaves dispatch_state untouched");
  assert.equal(deleteCount(), 0);
  assert.ok(lines.some((l) => l.includes('"event":"ring_dry_run"')), "dry_run logged");
  await actor.alarm(); // redelivery
  assert.equal(bumps.length, 1, "one ring per job even on a redelivered alarm");
});

test("alarm with a due ring_at and ring_mode off logs off and starts nothing", async () => {
  const { env, bumps } = dirEnv("off");
  const { actor } = makeActor(env);
  await actor.open(openArgs);
  await actor.setRingAt(Date.now() - 1);
  const lines = await captureLogs(() => actor.alarm());
  const rec = await actor.get();
  assert.equal(rec?.ring, undefined, "off feeds no reducer event");
  assert.equal(rec?.ring_start_reason, "mode_off");
  assert.equal(typeof rec?.ring_alarm_ran_at, "number");
  assert.equal(rec?.dispatch_state, undefined, "mode off leaves dispatch_state unchanged");
  assert.equal(bumps.length, 0, "off never touches the cap");
  assert.ok(
    lines.some((l) => l.includes('"event":"ring_start"') && l.includes('"node":"off"')),
    "off logged",
  );
});

test("retention due still deletes first and runs no ring even with ring_at pending", async () => {
  const { env, bumps } = dirEnv(null);
  const { actor, map, deleteCount } = makeActor(env);
  await actor.open(openArgs);
  await actor.setRingAt(Date.now() + 60_000);
  map.set("job", { ...(map.get("job") as Record<string, unknown>), retention_at: Date.now() - 1 });
  await actor.alarm();
  assert.equal(await actor.get(), null);
  assert.equal(deleteCount(), 1);
  assert.equal(bumps.length, 0, "retention wins; startRing never runs");
});

test("an error inside startRing logs ring_alarm_fail and never throws out of the alarm", async () => {
  const { env } = dirEnv("live", {
    JOBS: {
      idFromName: () => {
        throw new TypeError("jobs boom"); // buildRingDeps blows up
      },
    },
  });
  const { actor } = makeActor(env);
  await actor.open(openArgs);
  await actor.setRingAt(Date.now() - 1);
  const lines: string[] = [];
  const prior = console.log;
  console.log = (m: unknown) => {
    const s = String(m);
    if (s.includes("ring_start_fail")) throw new Error("log boom"); // startRing cannot even fail-log
    lines.push(s);
  };
  try {
    await actor.alarm(); // must not reject
  } finally {
    console.log = prior;
  }
  const rec = await actor.get();
  assert.ok(rec !== null, "the job survives a failed start");
  assert.equal(rec?.ring_at, undefined, "ring_at was consumed before the start");
  assert.equal(rec?.ring_start_reason, "run_error");
  assert.equal(rec?.dispatch_state, "unassigned", "a failed start never sits silently briefed");
  assert.equal(typeof rec?.ring_alarm_ran_at, "number");
  const failed = lines.filter((l) => l.includes('"event":"ring_alarm_fail"'));
  assert.equal(failed.length, 1, "ring_alarm_fail logged once");
  assert.ok(failed[0].includes('"error":"Error"'), "error name only");
});

test("alarm with the daily cap hit: reason capped, job ends exhausted and unassigned", async () => {
  const capped = {
    DIRECTORY: {
      idFromName: () => ({
        flag: async () => null, // dry_run
        bumpCounter: async () => ({ ok: false, count: 20 }), // cap hit
      }),
    },
  };
  const { env } = dirEnv(null, capped);
  const { actor } = makeActor(env);
  await actor.open(openArgs);
  await actor.setRingAt(Date.now() - 1);
  await captureLogs(() => actor.alarm());
  const rec = await actor.get();
  assert.ok(rec !== null);
  assert.equal(rec?.ring_start_reason, "capped");
  assert.equal(rec?.ring?.status, "exhausted", "a capped start feeds empty candidates");
  assert.equal(rec?.dispatch_state, "unassigned");
  assert.equal(typeof rec?.ring_alarm_ran_at, "number");
});

test("alarm with every candidate cooled down: reason no_candidates, exhausted, unassigned", async () => {
  const cooling = {
    TECH: {
      idFromName: () => ({
        status: async () => ({ last_ring_at: Date.now() }), // inside cooldown
      }),
    },
  };
  const { env } = dirEnv(null, cooling);
  const { actor } = makeActor(env);
  await actor.open(openArgs); // trade "plumber": the walk adds nobody, only tech-01
  await actor.setRingAt(Date.now() - 1);
  await captureLogs(() => actor.alarm());
  const rec = await actor.get();
  assert.ok(rec !== null);
  assert.equal(rec?.ring_start_reason, "no_candidates");
  assert.equal(rec?.ring?.status, "exhausted");
  assert.equal(rec?.dispatch_state, "unassigned");
});
