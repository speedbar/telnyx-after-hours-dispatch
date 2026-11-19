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
  customer_name: "Sam Rivera",
  address: "12 Banksia Street",
  callback_number: "0412 000 001",
  urgency: "emergency",
  trade: "plumbing",
  suburb: "Fitzroy",
  summary: "Burst pipe under the house",
});

// Uniform failure shape of S1.5: data, never thrown; bad_fields names only.
const fail = (reason: string, bad_fields: string[] = []) => ({
  ok: false,
  reason,
  next: "fallback",
  retry: false,
  bad_fields,
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
  assert.deepEqual(await lookup({ phone: "abc" }, env), fail("invalid_input", ["phone"]));
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
  // No technician identity or ETA leaks to the model (BUG-013).
  assert.equal(r1.technician_id, undefined);
  assert.equal(r1.technician_name, undefined);
  assert.equal(r1.eta_minutes, undefined);
  assert.equal(r1.attempt, 1);
  assert.equal(isJobId(r1.job_id), true);
  assert.ok(Date.parse(r1.hold_expires_at as string) > Date.now());

  // Replay with the same call_ref: same job, tech-02 untouched (attempt 2 next).
  const r1b = (await reserve(validReserve("call-001"), env)) as ToolResult;
  assert.equal(r1b.ok, true);
  assert.equal(r1b.job_id, r1.job_id);
  assert.equal(r1b.attempt, 1);

  const r2 = (await reserve(validReserve("call-002"), env)) as ToolResult;
  assert.equal(r2.attempt, 2);

  const r3 = await reserve(validReserve("call-003"), env);
  assert.deepEqual(r3, fail("no_technician_available"));
});

test("reserve_technician: flag false -> disabled", async () => {
  const env = await seeded("false");
  const r = await handler("reserve_technician")(validReserve("call-009"), env);
  assert.deepEqual(r, fail("disabled"));
});

test("reserve_technician: caller details required, SIP callback rejected, any call_ref string accepted", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  // Missing the caller details: cannot reserve before asking (BUG-006).
  const missing = await reserve(
    { call_ref: "call-100", urgency: "emergency", trade: "plumbing", suburb: "Fitzroy", summary: "Burst pipe" },
    env,
  );
  assert.deepEqual(missing, fail("invalid_input", ["customer_name", "address", "callback_number"]));
  // A SIP address as callback_number fails normalisePhone.
  assert.deepEqual(
    await reserve({ ...validReserve("call-101"), callback_number: "xxxx@sip.telnyx.com.au" }, env),
    fail("invalid_input", ["callback_number"]),
  );
  // A SIP address as call_ref is fine now: hashed to a c: ref (BUG-009).
  const r = (await reserve(validReserve("xxxx@sip.telnyx.com.au"), env)) as ToolResult;
  assert.equal(r.ok, true);
});

test("reserve_technician: meta conversation id wins; replay with a different model call_ref is idempotent", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const ctx = { meta_conversation_id: "conv-meta-1" };
  const r1 = (await reserve(validReserve("first-model-ref"), env, ctx)) as ToolResult;
  assert.equal(r1.ok, true);
  const r2 = (await reserve(validReserve("second-model-ref"), env, ctx)) as ToolResult;
  assert.equal(r2.ok, true);
  assert.equal(r2.job_id, r1.job_id);
});

test("create_job before reserve -> no_active_reservation", async () => {
  const env = await seeded();
  const r = await handler("create_job")(
    {
      call_ref: "call-404",
      customer_name: "Sam Rivera",
      address: "12 Banksia Street",
      details: "Burst pipe",
    },
    env,
  );
  assert.deepEqual(r, fail("no_active_reservation"));
});

test("create_job: happy path without job_id, replay, invented job_id ignored", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  const r1 = (await reserve(validReserve("call-010"), env)) as ToolResult;
  const job_id = r1.job_id as string;

  // No job_id from the model: the server reads it from the JobActor (BUG-007).
  const good = {
    call_ref: "call-010",
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

  // An invented model job_id is ignored silently.
  const invented = await create({ ...good, job_id: "JA0Z9Y" }, env);
  assert.deepEqual(invented, c1);
});

test("create_job after the hold expired -> hold_expired", async () => {
  const env = await seeded();
  (env as Record<string, unknown>).DISPATCH_HOLD_TTL_S = "1";
  await handler("reserve_technician")(validReserve("call-020"), env);
  await new Promise((r) => setTimeout(r, 1100));
  const r = await handler("create_job")(
    {
      call_ref: "call-020",
      customer_name: "Sam Rivera",
      address: "12 Banksia Street",
      details: "Burst pipe",
    },
    env,
  );
  assert.deepEqual(r, fail("hold_expired"));
});

test("create_job: blank optional fields count as not provided; non-empty invalid still fails", async () => {
  const env = await seeded();
  const create = handler("create_job");
  const r = (await handler("reserve_technician")(validReserve("call-060"), env)) as ToolResult;
  const job_id = r.job_id as string;
  const base = {
    call_ref: "call-060",
    customer_name: "Sam Rivera",
    address: "12 Banksia Street",
    details: "Burst pipe",
  };
  const good = { ok: true, job_id, reference_spoken: job_id.split("").join(" ") };
  assert.deepEqual(await create({ ...base, hazards: "" }, env), good);
  assert.deepEqual(await create({ ...base, hazards: "   " }, env), good);
  assert.deepEqual(await create({ ...base, contact_phone: "" }, env), good);
  const bad = await create({ ...base, contact_phone: "abc" }, env);
  assert.deepEqual(bad, fail("invalid_input", ["contact_phone"]));
});

test("release_technician: works without job_id; replay and unknown call are no_active_reservation", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const release = handler("release_technician");
  await reserve(validReserve("call-030"), env);
  await reserve(validReserve("call-031"), env);

  // Unknown call (model never reserved): no_active_reservation, still data.
  const unknown = await release(
    { call_ref: "call-zzz", reason: "declined" },
    env,
  );
  assert.deepEqual(unknown, fail("no_active_reservation"));

  // No job_id needed: the JobActor record is the truth.
  const first = await release(
    { call_ref: "call-031", reason: "no_answer" },
    env,
  );
  assert.deepEqual(first, {
    ok: true,
    released: true,
    next_technician_available: true,
  });

  // Replay of a closed job: no_active_reservation with next:"fallback".
  const replay = await release(
    { call_ref: "call-031", reason: "no_answer" },
    env,
  );
  assert.deepEqual(replay, fail("no_active_reservation"));
});

test("invalid_input for every tool", async () => {
  const env = await seeded();
  assert.deepEqual(
    await handler("lookup_customer")({ phone: "abc" }, env),
    fail("invalid_input", ["phone"]),
  );
  const reserve = handler("reserve_technician");
  for (const [args, fields] of [
    [{ ...validReserve("call-050"), suburb: "x".repeat(61) }, ["suburb"]],
    [{ ...validReserve("call-050"), urgency: "low" }, ["urgency"]],
    [{ ...validReserve("call-050"), summary: "\u0007" }, ["summary"]],
  ] as const) {
    assert.deepEqual(await reserve(args, env), fail("invalid_input", fields));
  }
  // A call_ref that is empty or too long (and no _meta id) cannot resolve.
  assert.deepEqual(
    await reserve(validReserve("x".repeat(201)), env),
    fail("invalid_input", ["call_ref"]),
  );
  const create = handler("create_job");
  for (const [args, fields] of [
    [
      {
        call_ref: "call-051",
        customer_name: "x".repeat(81),
        address: "a",
        details: "d",
      },
      ["customer_name"],
    ],
    [
      {
        call_ref: "call-051",
        customer_name: "n",
        address: "a",
        details: "\u0001\u0002",
      },
      ["details"],
    ],
  ] as const) {
    assert.deepEqual(await create(args, env), fail("invalid_input", fields));
  }
  assert.deepEqual(
    await handler("release_technician")(
      { call_ref: "call-052", reason: "bored" },
      env,
    ),
    fail("invalid_input", ["reason"]),
  );
});

test("privacy: no customer data in any log line", () => {
  for (const line of logLines) {
    for (const secret of ["Sam Rivera", "Banksia", "61412000001", "4471"]) {
      assert.ok(!line.includes(secret), `log line leaked ${secret}: ${line}`);
    }
  }
});
