// tests/tools.test.ts
// The four tool handlers against the REAL actor classes on Map-backed fake
// storage (no MCP protocol, no network). console.log is captured for the
// whole file for the privacy assertion at the bottom.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DirectoryActor } from "../src/actors/DirectoryActor.js";
import { TechnicianActor } from "../src/actors/TechnicianActor.js";
import { JobActor } from "../src/actors/JobActor.js";
import { keys } from "../src/lib/kv-keys.js";
import { isJobId } from "../src/lib/validate.js";
import { TOOLS, type ToolEnv, type ToolResult } from "../src/tools/index.js";

type DCtor = ConstructorParameters<typeof DirectoryActor>;
type TCtor = ConstructorParameters<typeof TechnicianActor>;
type JCtor = ConstructorParameters<typeof JobActor>;

function makeStorage() {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(
        map.has(key) ? (structuredClone(map.get(key)) as T) : undefined,
      );
    },
    put<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    setAlarm: () => Promise.resolve(),
    getAlarm: () => Promise.resolve(null),
    deleteAlarm: () => Promise.resolve(),
  };
}

function makeToolEnv(extra: Record<string, unknown> = {}) {
  const directory = new DirectoryActor(
    { storage: makeStorage() } as unknown as DCtor[0],
    {} as unknown as DCtor[1],
  );
  const techs = new Map<string, TechnicianActor>();
  const jobs = new Map<string, JobActor>();
  const env: ToolEnv = {
    DIRECTORY: { idFromName: () => directory },
    TECH: {
      idFromName: (name) => {
        let a = techs.get(name);
        if (!a) {
          a = new TechnicianActor(
            { storage: makeStorage() } as unknown as TCtor[0],
            {} as unknown as TCtor[1],
          );
          techs.set(name, a);
        }
        return a;
      },
    },
    JOBS: {
      idFromName: (name) => {
        let a = jobs.get(name);
        if (!a) {
          a = new JobActor(
            { storage: makeStorage() } as unknown as JCtor[0],
            {} as unknown as JCtor[1],
          );
          jobs.set(name, a);
        }
        return a;
      },
    },
    ...extra,
  };
  return { env, directory };
}

async function seeded(flag = "true") {
  const { env, directory } = makeToolEnv();
  await directory.seed([
    { key: keys.flag("dispatch_enabled"), value: flag },
    {
      key: keys.customer("+61412000001"),
      value: JSON.stringify({
        name: "Sam Rivera",
        address: "12 Banksia Street",
        site_notes: "Gate code 4471",
        after_hours_contract: true,
        extra: "dropped",
      }),
    },
    { key: keys.customer("+61499999999"), value: "not json {" },
  ]);
  return env;
}

function handler(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} registered`);
  return t.handler;
}

const validReserve = (call_ref: string) => ({
  call_ref,
  urgency: "emergency",
  trade: "plumbing",
  suburb: "Fitzroy",
  summary: "Burst pipe under the house",
});

const logLines: string[] = [];
const originalLog = console.log;
before(() => {
  console.log = (...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  };
});
after(() => {
  console.log = originalLog;
});

test("lookup_customer: known, unknown, bad phone, garbage record", async () => {
  const env = await seeded();
  const lookup = handler("lookup_customer");
  assert.deepEqual(await lookup({ phone: "0412 000 001" }, env), {
    ok: true,
    found: true,
    name: "Sam Rivera",
    address: "12 Banksia Street",
    site_notes: "Gate code 4471",
    after_hours_contract: true,
  });
  assert.deepEqual(await lookup({ phone: "0410 111 111" }, env), {
    ok: true,
    found: false,
  });
  assert.deepEqual(await lookup({ phone: "abc" }, env), {
    ok: false,
    reason: "invalid_input",
  });
  assert.deepEqual(await lookup({ phone: "+61499999999" }, env), {
    ok: true,
    found: false,
  });
});

test("reserve_technician: pool order, replay idempotency, exhaustion", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const r1 = (await reserve({ ...validReserve("call-001"), extra: "ignored" }, env)) as ToolResult;
  assert.equal(r1.ok, true);
  assert.equal(r1.technician_id, "tech-01");
  assert.equal(r1.technician_name, "Jordan");
  assert.equal(r1.eta_minutes, 30);
  assert.equal(r1.attempt, 1);
  assert.equal(isJobId(r1.job_id), true);
  assert.ok(Date.parse(r1.hold_expires_at as string) > Date.now());

  // Replay with the same call_ref: same job and technician, tech-02 untouched.
  const r1b = (await reserve(validReserve("call-001"), env)) as ToolResult;
  assert.equal(r1b.ok, true);
  assert.equal(r1b.job_id, r1.job_id);
  assert.equal(r1b.technician_id, "tech-01");

  const r2 = (await reserve(validReserve("call-002"), env)) as ToolResult;
  assert.equal(r2.technician_id, "tech-02");
  assert.equal(r2.attempt, 2);

  const r3 = await reserve(validReserve("call-003"), env);
  assert.deepEqual(r3, {
    ok: false,
    reason: "no_technician_available",
    next: "fallback",
  });
});

test("reserve_technician: flag false -> disabled", async () => {
  const env = await seeded("false");
  const r = await handler("reserve_technician")(validReserve("call-009"), env);
  assert.deepEqual(r, { ok: false, reason: "disabled", next: "fallback" });
});

test("create_job before reserve -> no_active_reservation", async () => {
  const env = await seeded();
  const r = await handler("create_job")(
    {
      call_ref: "call-404",
      job_id: "JA1B2C",
      customer_name: "Sam Rivera",
      address: "12 Banksia Street",
      details: "Burst pipe",
    },
    env,
  );
  assert.deepEqual(r, { ok: false, reason: "no_active_reservation" });
});

test("create_job: happy path, replay, wrong job_id", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  const r1 = (await reserve(validReserve("call-010"), env)) as ToolResult;
  const job_id = r1.job_id as string;

  const good = {
    call_ref: "call-010",
    job_id,
    customer_name: "Sam Rivera",
    address: "12 Banksia Street",
    contact_phone: "0412 000 001",
    details: "Burst pipe flooding the kitchen",
    hazards: "Water on the floor",
  };
  const c1 = await create(good, env);
  assert.deepEqual(c1, {
    ok: true,
    job_id,
    reference_spoken: job_id.split("").join(" "),
  });
  const c2 = await create(good, env);
  assert.deepEqual(c2, c1);

  const wrong = await create({ ...good, job_id: "JA0Z9Y" }, env);
  assert.deepEqual(wrong, { ok: false, reason: "no_active_reservation" });
});

test("create_job after the hold expired -> hold_expired", async () => {
  const env = await seeded();
  (env as Record<string, unknown>).DISPATCH_HOLD_TTL_S = "1";
  const r1 = (await handler("reserve_technician")(validReserve("call-020"), env)) as ToolResult;
  await new Promise((r) => setTimeout(r, 1100));
  const r = await handler("create_job")(
    {
      call_ref: "call-020",
      job_id: r1.job_id,
      customer_name: "Sam Rivera",
      address: "12 Banksia Street",
      details: "Burst pipe",
    },
    env,
  );
  assert.deepEqual(r, { ok: false, reason: "hold_expired", next: "fallback" });
});

test("release_technician: release true then false, availability", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const release = handler("release_technician");
  await reserve(validReserve("call-030"), env);
  const r2 = (await reserve(validReserve("call-031"), env)) as ToolResult;

  // Unknown job while both techs held: released false, none available.
  const unknown = await release(
    { call_ref: "call-zzz", job_id: "JA9Z8Y", reason: "declined" },
    env,
  );
  assert.deepEqual(unknown, {
    ok: true,
    released: false,
    next_technician_available: false,
  });

  const first = await release(
    { call_ref: "call-031", job_id: r2.job_id, reason: "no_answer" },
    env,
  );
  assert.deepEqual(first, {
    ok: true,
    released: true,
    next_technician_available: true,
  });

  // Replay: released false, still safe.
  const replay = await release(
    { call_ref: "call-031", job_id: r2.job_id, reason: "no_answer" },
    env,
  );
  assert.deepEqual(replay, {
    ok: true,
    released: false,
    next_technician_available: true,
  });
});

test("invalid_input for every tool", async () => {
  const env = await seeded();
  assert.deepEqual(await handler("lookup_customer")({ phone: "abc" }, env), {
    ok: false,
    reason: "invalid_input",
  });
  const reserve = handler("reserve_technician");
  for (const args of [
    { ...validReserve("call-050"), suburb: "x".repeat(61) },
    { ...validReserve("call-050"), urgency: "low" },
    { ...validReserve("has a space") },
    { ...validReserve("call-050"), summary: "\u0007" },
  ]) {
    assert.deepEqual(await reserve(args, env), {
      ok: false,
      reason: "invalid_input",
      next: "fallback",
    });
  }
  const create = handler("create_job");
  for (const args of [
    {
      call_ref: "call-051",
      job_id: "JA1B2C",
      customer_name: "x".repeat(81),
      address: "a",
      details: "d",
    },
    {
      call_ref: "call-051",
      job_id: "JA1B2C",
      customer_name: "n",
      address: "a",
      details: "\u0001\u0002",
    },
  ]) {
    assert.deepEqual(await create(args, env), {
      ok: false,
      reason: "invalid_input",
    });
  }
  assert.deepEqual(
    await handler("release_technician")(
      { call_ref: "call-052", job_id: "JA1B2C", reason: "bored" },
      env,
    ),
    { ok: false, reason: "invalid_input" },
  );
});

test("privacy: no customer data in any log line", () => {
  for (const line of logLines) {
    for (const secret of ["Sam Rivera", "Banksia", "61412000001", "4471"]) {
      assert.ok(!line.includes(secret), `log line leaked ${secret}: ${line}`);
    }
  }
});
