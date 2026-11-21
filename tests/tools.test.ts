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
import { isJobId, resolveCallRef } from "../src/lib/validate.js";
import { TOOLS, type TechStub, type ToolEnv, type ToolResult } from "../src/tools/index.js";
import { handleMcp, type McpEnv } from "../src/routes/mcp.js";
import { callerHash, toolLogCtxOf } from "../src/lib/log.js";

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

// The full stored JobRecord for a model-side call_ref (resolved the same way
// the tools resolve it). Observation only; nothing here reaches the model.
async function jobRecord(env: ToolEnv, call_ref: string) {
  const { ref } = await resolveCallRef({ call_ref }, {});
  const rec = await env.JOBS?.idFromName(ref as string).get();
  return rec as unknown as {
    job_id: string;
    tech_id: string;
    urgency: string;
    trade: string;
    flags?: string[];
    customer_name?: string;
    address?: string;
    contact_phone?: string;
    details?: string;
    hazards?: string;
  } | null;
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
  // S1.8: plumbing is eligible on tech-01 then tech-03.
  assert.equal((await jobRecord(env, "call-001"))?.tech_id, "tech-01");

  // Replay with the same call_ref: same job, tech-03 untouched (attempt 2 next).
  const r1b = (await reserve(validReserve("call-001"), env)) as ToolResult;
  assert.equal(r1b.ok, true);
  assert.equal(r1b.job_id, r1.job_id);
  assert.equal(r1b.attempt, 1);

  const r2 = (await reserve(validReserve("call-002"), env)) as ToolResult;
  assert.equal(r2.attempt, 2);
  assert.equal((await jobRecord(env, "call-002"))?.tech_id, "tech-03");

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

// D20-5b: a successful create_job schedules the alarm-driven ring start
// (ring_at about RING_START_DELAY_MS out); a setRingAt failure is logged and
// never changes the result.
test("create_job schedules ring_at; setRingAt failure keeps the result identical", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  const r1 = (await reserve(validReserve("call-080"), env)) as ToolResult;
  const job_id = r1.job_id as string;
  const good = {
    call_ref: "call-080",
    customer_name: "Sam Rivera",
    address: "12 Banksia Street",
    details: "Burst pipe flooding the kitchen",
  };
  const want = { ok: true, job_id, reference_spoken: job_id.split("").join(" ") };
  const c1 = await create(good, env);
  assert.deepEqual(c1, want);
  const rec1 = (await jobRecord(env, "call-080")) as unknown as { ring_at?: number };
  const delay = (rec1?.ring_at ?? NaN) - Date.now();
  assert.ok(delay <= 1000 && delay > -2000, `ring_at about 1s out, got ${String(delay)}`);

  const r2 = (await reserve(validReserve("call-081"), env)) as ToolResult;
  const job_id2 = r2.job_id as string;
  const { ref } = await resolveCallRef({ call_ref: "call-081" }, {});
  const stub = env.JOBS?.idFromName(ref as string) as unknown as {
    setRingAt(ms: number): Promise<{ ok: boolean }>;
  };
  stub.setRingAt = () => Promise.reject(new RangeError("message-must-not-appear"));
  const before = logLines.length;
  const c2 = await create({ ...good, call_ref: "call-081" }, env);
  assert.deepEqual(c2, {
    ok: true,
    job_id: job_id2,
    reference_spoken: job_id2.split("").join(" "),
  });
  const failed = logLines
    .slice(before)
    .filter((l) => l.includes('"event":"ring_schedule_fail"'));
  assert.equal(failed.length, 1, "ring_schedule_fail logged once");
  assert.ok(failed[0].includes('"error":"RangeError"'), "error name only");
  assert.ok(!failed[0].includes("message-must-not-appear"), "message never logged");
});

// D20-5e: the fresh-success path also stores the single-use ring callback —
// a random 32-hex token and origin + "/ring-start" — on the job. Both must
// stay off the tool result and every log line.
test("create_job stores the ring token and callback; they never reach the model or the logs", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  const r1 = (await reserve(validReserve("call-090"), env)) as ToolResult;
  const job_id = r1.job_id as string;
  const before = logLines.length;
  const c = await create(
    { call_ref: "call-090", customer_name: "Sam Rivera", address: "12 Banksia Street", details: "Burst pipe" },
    env,
    { origin: "https://fn.example" },
  );
  assert.deepEqual(c, { ok: true, job_id, reference_spoken: job_id.split("").join(" ") });
  const rec = (await jobRecord(env, "call-090")) as unknown as {
    ring_token?: string;
    ring_cb?: string;
  };
  assert.match(rec?.ring_token ?? "", /^[0-9a-f]{32}$/, "16 random bytes as hex");
  assert.equal(rec?.ring_cb, "https://fn.example/ring-start");
  const blob = JSON.stringify(c) + "\n" + logLines.slice(before).join("\n");
  assert.ok(rec?.ring_token !== undefined && !blob.includes(rec.ring_token), "token in no result or log line");
  assert.ok(!logLines.slice(before).join("\n").includes("fn.example"), "callback URL never logged");
});

test("create_job after the hold expired -> hold_expired", async () => {
  const env = await seeded();  (env as Record<string, unknown>).DISPATCH_HOLD_TTL_S = "1";
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

// S1.8 item 1: eligibility is built from trades, in pool order.
test("reserve_technician: a gas job reserves tech-01 only, never tech-02 or tech-03", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const gas = { ...validReserve("gas-1"), trade: "gas", summary: "The heater pilot light keeps going out" };
  const r1 = (await reserve(gas, env)) as ToolResult;
  assert.equal(r1.ok, true);
  assert.equal(r1.attempt, 1);
  assert.equal((await jobRecord(env, "gas-1"))?.tech_id, "tech-01");
  // tech-01 held: a second gas job finds nobody eligible (next:"fallback").
  assert.deepEqual(await reserve({ ...gas, call_ref: "gas-2" }, env), fail("no_technician_available"));
});

test("reserve_technician: electrical and hvac go to tech-02; plumbing tries tech-01 then tech-03", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const r1 = (await reserve({ ...validReserve("tr-elec"), trade: "electrical" }, env)) as ToolResult;
  assert.equal(r1.ok, true);
  assert.equal((await jobRecord(env, "tr-elec"))?.tech_id, "tech-02");
  // hvac has the same single eligible technician: held tech-02 -> nobody.
  assert.deepEqual(
    await reserve({ ...validReserve("tr-hvac"), trade: "hvac" }, env),
    fail("no_technician_available"),
  );
  const p1 = (await reserve(validReserve("tr-plum-1"), env)) as ToolResult;
  assert.equal(p1.attempt, 1);
  assert.equal((await jobRecord(env, "tr-plum-1"))?.tech_id, "tech-01");
  const p2 = (await reserve(validReserve("tr-plum-2"), env)) as ToolResult;
  assert.equal(p2.ok, true);
  assert.equal(p2.attempt, 2);
  assert.equal((await jobRecord(env, "tr-plum-2"))?.tech_id, "tech-03");
  // Both plumbing technicians held: a trade nobody free has ends as data.
  assert.deepEqual(await reserve(validReserve("tr-plum-3"), env), fail("no_technician_available"));
});

// S1.8 item 2: the effective (floored) values are stored and drive eligibility.
test("reserve_technician: a gas keyword corrects the trade and raises urgency before routing", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const r = (await reserve(
    { ...validReserve("floor-1"), trade: "plumbing", urgency: "urgent", summary: "There is a gas smell near the hot water unit" },
    env,
  )) as ToolResult;
  assert.equal(r.ok, true);
  const rec = await jobRecord(env, "floor-1");
  assert.equal(rec?.trade, "gas");
  assert.equal(rec?.urgency, "emergency");
  assert.equal(rec?.tech_id, "tech-01");
});

// S1.8 item 3: only an undiallable callback is a hard reject.
test("reserve_technician: undiallable callback numbers are rejected; AU mobile and international pass", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const bad = ["0412345", "000", "112", "0000000000"];
  for (let i = 0; i < bad.length; i++) {
    assert.deepEqual(
      await reserve({ ...validReserve(`cb-bad-${i}`), callback_number: bad[i] }, env),
      fail("invalid_input", ["callback_number"]),
    );
  }
  const au = (await reserve({ ...validReserve("cb-au"), callback_number: "0400 123 456" }, env)) as ToolResult;
  assert.equal(au.ok, true);
  const intl = (await reserve({ ...validReserve("cb-intl"), callback_number: "+44 20 7123 4567" }, env)) as ToolResult;
  assert.equal(intl.ok, true);
});

// S1.8 item 3: soft flags accept the job, live on the record, never reach the model.
test("reserve_technician: an address without a house number reserves and stores the flag", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const r = (await reserve({ ...validReserve("flag-1"), address: "Banksia Street" }, env)) as ToolResult;
  assert.equal(r.ok, true);
  assert.equal(r.flags, undefined);
  const rec = await jobRecord(env, "flag-1");
  assert.deepEqual(rec?.flags, ["address_no_house_number"]);
  // job_opened logs the flag names only.
  assert.ok(
    logLines.some((l) => l.includes('"event":"job_opened"') && l.includes("address_no_house_number")),
    "flag names must appear on the job_opened log line",
  );
});

// S1.8 3b: the callback validated at reservation is the record (F10).
test("create_job: the confirmed reservation callback wins over a missing or different contact_phone", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  await reserve({ ...validReserve("sc-1"), callback_number: "0412 000 001" }, env);
  const base = { call_ref: "sc-1", customer_name: "Sam Rivera", address: "12 Banksia Street", details: "Burst pipe" };
  // No contact_phone at all (F10): the reservation value survives.
  const c1 = await create(base, env);
  assert.equal(c1.ok, true);
  assert.equal((await jobRecord(env, "sc-1"))?.contact_phone, "61412000001");
  // A different contact_phone later still loses.
  const c2 = await create({ ...base, contact_phone: "+61 422 000 002" }, env);
  assert.equal(c2.ok, true);
  assert.equal((await jobRecord(env, "sc-1"))?.contact_phone, "61412000001");
});

test("create_job: 'none'-style hazards are not stored; real hazards are", async () => {
  for (const [ref, trade, hazards, stored] of [
    ["hz-none", "plumbing", "none", undefined],
    ["hz-no", "electrical", "No.", undefined],
    ["hz-real", "plumbing", "gas smell", "gas smell"],
  ] as const) {
    const env = await seeded();
    await handler("reserve_technician")({ ...validReserve(ref), trade }, env);
    const c = await handler("create_job")(
      { call_ref: ref, customer_name: "Sam Rivera", address: "12 Banksia Street", details: "Burst pipe", hazards },
      env,
    );
    assert.equal(c.ok, true);
    assert.equal((await jobRecord(env, ref))?.hazards, stored);
  }
});

// S1.8 item 4: first write wins on briefing.
test("create_job: a second create_job returns the same job and never overwrites", async () => {
  const env = await seeded();
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  const r = (await reserve(validReserve("br-1"), env)) as ToolResult;
  const job_id = r.job_id as string;
  const good = { ok: true, job_id, reference_spoken: job_id.split("").join(" ") };
  const c1 = await create(
    { call_ref: "br-1", customer_name: "Sam Rivera", address: "12 Banksia Street", details: "Burst pipe under the house" },
    env,
  );
  assert.deepEqual(c1, good);
  const c2 = await create(
    { call_ref: "br-1", customer_name: "Nope Nope", address: "999 Wrong Road", details: "a totally different story" },
    env,
  );
  assert.deepEqual(c2, good);
  const rec = await jobRecord(env, "br-1");
  assert.equal(rec?.customer_name, "Sam Rivera");
  assert.equal(rec?.details, "Burst pipe under the house");
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

// S1.9 (BUG-005): the hop timings measured inside the tools land on the
// route's mcp_call line as numbers; never any argument values.
test("S1.9: hop timing fields appear on mcp_call; no argument values logged", async () => {
  const TOKEN = "s19-instrument-token-0123456789";
  const env = await seeded();
  env.MCP_TOKEN = TOKEN;
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const req = new Request("https://test.invalid/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const res = await handleMcp(req, env as McpEnv);
    assert.equal(res.status, 200);
    await res.text();
  };
  const before = logLines.length;
  await callTool("reserve_technician", validReserve("hop-1"));
  await callTool("create_job", {
    call_ref: "hop-1",
    customer_name: "Sam Rivera",
    address: "12 Banksia Street",
    details: "Burst pipe under the house",
  });
  const lines = logLines
    .slice(before)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const reserve = lines.find((l) => l.event === "mcp_call" && l.tool === "reserve_technician");
  const created = lines.find((l) => l.event === "mcp_call" && l.tool === "create_job");
  assert.ok(reserve && created, "expected mcp_call lines for both tools");
  for (const k of ["hop_flag_ms", "hop_job_get_ms", "hop_tech_ms", "hop_job_open_ms"]) {
    assert.equal(typeof reserve[k], "number", `${k} must be a number on the reserve mcp_call`);
    assert.ok((reserve[k] as number) >= 0);
  }
  for (const k of ["hop_job_get_ms", "hop_tech_status_ms", "hop_brief_ms", "hop_mark_booked_ms", "hop_job_write_ms"]) {
    assert.equal(typeof created[k], "number", `${k} must be a number on the create_job mcp_call`);
    assert.ok((created[k] as number) >= 0);
  }
  // The tool-call total stays in latency_ms.
  assert.equal(typeof reserve.latency_ms, "number");

  // S1.9b: the job write is the brief RPC (same value, both names) and the
  // distinct-await hops add up to the total within about 30 ms.
  assert.equal(created.hop_job_write_ms, created.hop_brief_ms);
  const cjSum =
    (created.hop_job_get_ms as number) +
    (created.hop_tech_status_ms as number) +
    (created.hop_brief_ms as number) +
    (created.hop_mark_booked_ms as number);
  assert.ok(
    Math.abs(cjSum - (created.latency_ms as number)) <= 30,
    `create_job hops ${cjSum} vs total ${created.latency_ms}`,
  );

  // S1.9b: flag_source and eligible_count on the reserve ok line, boot facts
  // on every mcp_call (first_request true exactly once per instance).
  assert.equal(reserve.flag_source, "cache");
  assert.equal(reserve.eligible_count, 2);
  for (const l of [reserve, created]) {
    assert.equal(typeof l.boot_age_ms, "number");
    assert.ok((l.boot_age_ms as number) >= 0);
  }
  assert.equal(reserve.first_request, true, "first mcp_call of the instance");
  assert.equal(created.first_request, false);

  const joined = logLines.slice(before).join("\n");
  for (const bad of ["Sam Rivera", "Banksia", "61412000001", "0412 000 001", "Burst pipe under the house"]) {
    assert.ok(!joined.includes(bad), `log leaked argument value: ${bad}`);
  }
});

// S1.9b: flag_source distinguishes the actor read ("cache") from the implicit
// enabled default when the flag key is missing; never a KV read or a timeout.
test("S1.9b: flag_source is cache when seeded, default when the key is missing", async () => {
  const withFlag = await seeded();
  const ctx1 = {};
  const r1 = (await handler("reserve_technician")(validReserve("fs-1"), withFlag, ctx1)) as ToolResult;
  assert.equal(r1.ok, true);
  assert.equal(toolLogCtxOf(ctx1).flag_source, "cache");
  assert.equal(toolLogCtxOf(ctx1).eligible_count, 2);

  const noFlag = makeToolEnv().env;
  const ctx2 = {};
  const r2 = (await handler("reserve_technician")(validReserve("fs-2"), noFlag, ctx2)) as ToolResult;
  assert.equal(r2.ok, true, "a missing flag is the enabled default");
  assert.equal(toolLogCtxOf(ctx2).flag_source, "default");
});

// S1.9 item 5 (a)-(d): technician ids, urgency from/to + category, one
// request_id per tool call, and conv_hash on every MCP line.
test("S1.9: technician_id, urgency_raised detail, shared request_id and conv_hash", async () => {
  const TOKEN = "s19-correlation-token-012345678";
  const env = await seeded();
  env.MCP_TOKEN = TOKEN;
  env.LOG_SALT = "tools-salt";
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const req = new Request("https://test.invalid/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: { telnyx_conversation_id: "conv-shared-1" },
        },
      }),
    });
    const res = await handleMcp(req, env as McpEnv);
    assert.equal(res.status, 200);
    await res.text();
  };
  const before = logLines.length;
  // Gas trade + urgent: applyFloors raises to emergency (floor_reason "gas").
  await callTool("reserve_technician", {
    ...validReserve("s19-gas"),
    trade: "gas",
    urgency: "urgent",
    summary: "The heater pilot light keeps going out",
  });
  const lines = logLines
    .slice(before)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const mcpCall = lines.find((l) => l.event === "mcp_call" && l.tool === "reserve_technician");
  assert.ok(mcpCall, "expected the reserve mcp_call line");
  const request_id = mcpCall.request_id;
  assert.match(String(request_id), /^[0-9a-f-]{36}$/);
  const conv_hash = await callerHash("conv-shared-1", "tools-salt");

  // (a) technician_id on reserve_attempt and mcp_call (id only).
  assert.equal(mcpCall.technician_id, "tech-01");
  assert.equal(mcpCall.conv_hash, conv_hash);
  const attempts = lines.filter((l) => l.event === "reserve_attempt" && l.component === "mcp");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].technician_id, "tech-01");
  assert.equal(attempts[0].attempt, 1);
  assert.equal(attempts[0].eligible_count, 1);

  // (b) urgency_raised: enum from/to and a fixed category, never the summary.
  const raised = lines.find((l) => l.event === "urgency_raised");
  assert.ok(raised, "expected an urgency_raised line");
  assert.equal(raised.urgency_from, "urgent");
  assert.equal(raised.urgency_to, "emergency");
  assert.equal(raised.floor_reason, "gas");

  // (c)(d) one request_id and the conv_hash on every line of this tool call.
  for (const l of [raised, attempts[0], mcpCall]) {
    assert.equal(l.request_id, request_id, `${l.event} shares the request_id`);
    assert.equal(l.conv_hash, conv_hash, `${l.event} carries conv_hash`);
  }

  // No summary text, no raw conversation id, no customer data anywhere.
  const joined = logLines.slice(before).join("\n");
  for (const bad of ["pilot light", "The heater", "conv-shared-1", "Sam Rivera", "Banksia", "61412000001"]) {
    assert.ok(!joined.includes(bad), `log leaked: ${bad}`);
  }

  // (a) create_job also names the job's technician on its mcp_call line.
  const before2 = logLines.length;
  await callTool("create_job", {
    call_ref: "s19-gas",
    customer_name: "Sam Rivera",
    address: "12 Banksia Street",
    details: "Pilot light out",
  });
  const lines2 = logLines
    .slice(before2)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const created = lines2.find((l) => l.event === "mcp_call" && l.tool === "create_job");
  assert.ok(created, "expected the create_job mcp_call line");
  assert.equal(created.technician_id, "tech-01");
  // Same conversation id -> same conv_hash across tool calls.
  assert.equal(created.conv_hash, conv_hash);
});

// S1.9 follow-up: a failing markBooked is one warn line (category only) and
// create_job still returns ok — the job is already briefed by then.
test("create_job: markBooked throwing is a warn line and the result is still ok", async () => {
  const env = await seeded();
  const realTech = env.TECH;
  assert.ok(realTech, "seeded env has TECH");
  env.TECH = {
    idFromName: (name: string) => {
      const actor = realTech.idFromName(name);
      return {
        reserve: (args: Parameters<TechStub["reserve"]>[0]) => actor.reserve(args),
        release: (args: Parameters<TechStub["release"]>[0]) => actor.release(args),
        status: () => actor.status(),
        markBooked: () => Promise.reject(new Error("markBooked secret payload")),
      } as TechStub;
    },
  };
  const reserve = handler("reserve_technician");
  const create = handler("create_job");
  await reserve(validReserve("mb-1"), env);
  const before = logLines.length;
  const r = await create(
    { call_ref: "mb-1", customer_name: "Sam Rivera", address: "12 Banksia Street", details: "Burst pipe" },
    env,
  );
  assert.equal(r.ok, true);
  assert.equal(isJobId(r.job_id), true);
  const lines = logLines
    .slice(before)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const warn = lines.find((l) => l.event === "mark_booked_failed");
  assert.ok(warn, "expected a mark_booked_failed warn line");
  assert.equal(warn.level, "warn");
  assert.equal(warn.tool, "create_job");
  assert.equal(warn.error, "Error", "category only, not the message");
  assert.equal(warn.job_id, r.job_id);
  assert.ok(
    !logLines.slice(before).join("\n").includes("secret payload"),
    "no error message values in any log line",
  );
});

test("privacy: no customer data in any log line", () => {
  for (const line of logLines) {
    for (const secret of ["Sam Rivera", "Banksia", "61412000001", "4471"]) {
      assert.ok(!line.includes(secret), `log line leaked ${secret}: ${line}`);
    }
  }
});
