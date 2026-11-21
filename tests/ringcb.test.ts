// tests/ringcb.test.ts
// D20-5f: ring-start callback diagnostics on the JobActor alarm (ring_cb_error
// / ring_cb_host / ring_cb_ms), timeout, one retry, and the /admin/job-state
// surface. fetch is stubbed; no network. An AbortError-named rejection stands
// in for the abort signal (the 8000 ms timer itself is not waited out).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JobActor } from "../src/actors/JobActor.js";
import {
  handleJobState,
  type JobStateEnv,
  type JobStateStub,
} from "../src/routes/jobstate.js";

type CtorArgs = ConstructorParameters<typeof JobActor>;

// Same Map-backed fake storage as tests/job.test.ts.
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

const originalLog = console.log;
before(() => {
  console.log = () => {};
});
after(() => {
  console.log = originalLog;
});

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

async function withFetch(
  fake: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const prior = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) =>
    fake(String(input), init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = prior;
  }
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

const openArgs = {
  job_id: "j1",
  tech_id: "tech-01",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Brunswick",
  summary: "burst pipe",
};
const RING_TOKEN = "0123456789abcdef0123456789abcdef";
const RING_CB = "https://cb.example/ring-start";

// Open a job with a ring already due and the callback stored.
async function dueJob(cb: string = RING_CB) {
  const fake = makeActor();
  await fake.actor.open(openArgs);
  await fake.actor.setRingAt(Date.now() - 1, { token: RING_TOKEN, cb });
  return fake;
}

const okResponse = () =>
  new Response(JSON.stringify({ ok: true, reason: "ok" }), { status: 200 });

test("fetch throw -> network after one retry; abort -> timeout after one retry", async () => {
  const { actor } = await dueJob();
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.reject(new TypeError("no net"));
    },
    () => actor.alarm(),
  );
  assert.equal(calls, 2, "one retry on a network error");
  const rec = await actor.get();
  assert.equal(rec?.ring_cb_error, "network");
  assert.equal(rec?.ring_start_reason, "callback_error");
  assert.equal(rec?.dispatch_state, "unassigned");
  assert.equal(typeof rec?.ring_cb_ms, "number");
  assert.equal(rec?.ring_cb_host, "cb.example");

  const { actor: a2 } = await dueJob();
  let calls2 = 0;
  await withFetch(
    () => {
      calls2++;
      return Promise.reject(abortError());
    },
    () => a2.alarm(),
  );
  assert.equal(calls2, 2, "one retry on a timeout");
  const rec2 = await a2.get();
  assert.equal(rec2?.ring_cb_error, "timeout");
  assert.equal(rec2?.ring_start_reason, "callback_error");
  assert.equal(rec2?.dispatch_state, "unassigned");
});

test("non-200 -> http_<status>, no retry; a 200 without ok+reason -> bad_body, no retry", async () => {
  const { actor } = await dueJob();
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(new Response("boom", { status: 500 }));
    },
    () => actor.alarm(),
  );
  assert.equal(calls, 1, "no retry on an HTTP status");
  const rec = await actor.get();
  assert.equal(rec?.ring_cb_error, "http_500");
  assert.equal(rec?.ring_start_reason, "callback_error");
  assert.equal(rec?.dispatch_state, "unassigned");
  assert.equal(typeof rec?.ring_cb_ms, "number");

  for (const body of ["not json", JSON.stringify({ hello: "world" })]) {
    const { actor: a } = await dueJob();
    let n = 0;
    await withFetch(
      () => {
        n++;
        return Promise.resolve(new Response(body, { status: 200 }));
      },
      () => a.alarm(),
    );
    assert.equal(n, 1, "no retry on a bad body");
    const r = await a.get();
    assert.equal(r?.ring_cb_error, "bad_body");
    assert.equal(r?.ring_start_reason, "callback_error");
    assert.equal(r?.dispatch_state, "unassigned");
  }
});

test("success after one failed attempt: reason from the response, no error recorded", async () => {
  const { actor } = await dueJob();
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return calls === 1 ? Promise.reject(new TypeError("no net")) : Promise.resolve(okResponse());
    },
    () => actor.alarm(),
  );
  assert.equal(calls, 2);
  const rec = await actor.get();
  assert.equal(rec?.ring_start_reason, "ok");
  assert.equal(rec?.ring_cb_error, undefined, "no error recorded on success");
  assert.equal(typeof rec?.ring_cb_ms, "number", "elapsed recorded on success too");
  assert.equal(rec?.dispatch_state, undefined, "an ok start never marks unassigned");
});

test("mode_off stays a non-error and leaves dispatch_state untouched", async () => {
  const { actor } = await dueJob();
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, reason: "mode_off" }), { status: 200 }),
      ),
    () => actor.alarm(),
  );
  const rec = await actor.get();
  assert.equal(rec?.ring_start_reason, "mode_off");
  assert.equal(rec?.ring_cb_error, undefined);
  assert.equal(rec?.dispatch_state, undefined);
});

test("no callback or no token stored -> no_cb and no POST", async () => {
  const { actor } = makeActor();
  await actor.open(openArgs);
  await actor.setRingAt(Date.now() - 1); // no ring token/cb stored
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(okResponse());
    },
    () => actor.alarm(),
  );
  assert.equal(calls, 0);
  const rec = await actor.get();
  assert.equal(rec?.ring_cb_error, "no_cb");
  assert.equal(rec?.ring_start_reason, "callback_error");
  assert.equal(rec?.dispatch_state, "unassigned");
  assert.equal(rec?.ring_cb_host, undefined);
});

test("ring_cb_host is the hostname only; token and full URL appear in no record field and no log line", async () => {
  const SECRET = "sekretquerytoken";
  const cb = `https://cb.example:8443/ring-start?token=${SECRET}`;
  const { actor } = await dueJob(cb);
  const lines = await captureLogs(() =>
    withFetch(
      () => Promise.resolve(new Response("boom", { status: 403 })),
      () => actor.alarm(),
    ),
  );
  const rec = await actor.get();
  assert.equal(rec?.ring_cb_host, "cb.example", "hostname only, no port/path/query");
  assert.equal(rec?.ring_cb_error, "http_403");
  // ring_cb (the stored callback URL) is the one field allowed to hold the
  // URL; the new diagnostic fields and every log line must not.
  const newFields = JSON.stringify({
    e: rec?.ring_cb_error,
    h: rec?.ring_cb_host,
    m: rec?.ring_cb_ms,
    r: rec?.ring_start_reason,
  });
  const logs = lines.join("\n");
  for (const blob of [newFields, logs]) {
    assert.ok(!blob.includes(SECRET), "query token nowhere");
    assert.ok(!blob.includes(RING_TOKEN), "ring token nowhere");
    assert.ok(!blob.includes(cb), "full URL nowhere");
    assert.ok(!blob.includes("8443"), "port nowhere");
  }
});

test("alarm still never throws; retention still deletes first (no callback fired)", async () => {
  // Never throws even when every attempt fails.
  const { actor } = await dueJob();
  await withFetch(
    () => Promise.reject(new TypeError("no net")),
    async () => {
      await actor.alarm();
    },
  );
  // Retention due wins over a pending ring: the job is deleted, no POST.
  const fake = makeActor();
  await fake.actor.open(openArgs);
  await fake.actor.setRingAt(Date.now() - 1, { token: RING_TOKEN, cb: RING_CB });
  fake.map.set("job", {
    ...(fake.map.get("job") as Record<string, unknown>),
    retention_at: Date.now() - 1,
  });
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(okResponse());
    },
    () => fake.actor.alarm(),
  );
  assert.equal(await fake.actor.get(), null);
  assert.equal(fake.deleteCount(), 1);
  assert.equal(calls, 0, "retention deletes first; callback never fires");
});

test("job-state returns the three new fields and still no PII or token", async () => {
  const past = Date.now() - 60_000;
  const record = {
    call_ref: "c:dummy",
    job_id: "JA4F7C",
    tech_id: "tech-01",
    state: "reserved",
    dispatch_state: "unassigned",
    urgency: "emergency",
    trade: "plumbing",
    suburb: "Simville",
    summary: "Burst pipe flooding the kitchen",
    customer_name: "Jane Citizen",
    address: "12 Fake Street, Simville",
    contact_phone: "61400111222",
    retention_at: past + 7 * 86_400_000,
    ring_alarm_ran_at: past + 500,
    ring_start_reason: "callback_error",
    ring_cb_error: "http_502",
    ring_cb_host: "cb.example",
    ring_cb_ms: 812,
    ring_token: RING_TOKEN,
    ring_cb: `https://cb.example/ring-start?token=sekret`,
    created_at: past - 100,
    updated_at: past,
  };
  const stub: JobStateStub = { get: async () => record as Awaited<ReturnType<JobStateStub["get"]>> };
  const env: JobStateEnv = {
    ADMIN_TOKEN: "job-state-admin-token",
    JOBS: { idFromName: () => stub },
  };
  const res = await handleJobState(
    new Request("https://test.invalid/admin/job-state", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "job-state-admin-token" },
      body: JSON.stringify({ call_ref: "call-x" }),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  const json = JSON.parse(text) as Record<string, unknown>;
  assert.equal(json.ring_cb_error, "http_502");
  assert.equal(json.ring_cb_host, "cb.example");
  assert.equal(json.ring_cb_ms, 812);
  assert.ok(!text.includes(RING_TOKEN), "no ring token");
  assert.ok(!text.includes("sekret"), "no callback query token");
  assert.ok(!text.includes("61400111222"), "no contact phone digits");
  assert.ok(!text.includes("Jane Citizen"), "no customer name");
  assert.ok(!text.includes("Fake Street"), "no address");
  assert.ok(!text.includes("Burst pipe"), "no summary");
});
