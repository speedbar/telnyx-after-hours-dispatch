// tests/job.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JobActor } from "../src/actors/JobActor.js";

// Map-backed fake ctx.storage; get() returns a structuredClone so tests mimic
// the runtime (no shared object references). The fake ctx has no id, so
// call_ref falls back to "call". Supports the alarm API (setAlarm/getAlarm/
// deleteAlarm/delete) like the real Stateful Actor storage.
type CtorArgs = ConstructorParameters<typeof JobActor>;

function makeActor() {
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
    {} as unknown as CtorArgs[1],
  );
  return { actor, map, alarm: () => alarmAt, deleteCount: () => deleteCount };
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
// arms the retention alarm; alarm() deletes once and is idempotent.
test("open stores flags and caller details, sets a retention alarm, alarm deletes once", async () => {
  const { actor, alarm, deleteCount } = makeActor();
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
