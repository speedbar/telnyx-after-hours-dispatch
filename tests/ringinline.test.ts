// tests/ringinline.test.ts
// D20-5g: create_job starts the ring inline (default) under a hard timeout,
// cancels the alarm backstop on a start, keeps it as fallback on a transient
// miss, and never lets the ring fail the tool result. Map-backed fakes with
// the REAL actor classes; the only network-shaped seam is the injected
// dialer/deps (RingDepsFactory), so nothing dials for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectoryActor } from "../src/actors/DirectoryActor.js";
import { TechnicianActor } from "../src/actors/TechnicianActor.js";
import { JobActor } from "../src/actors/JobActor.js";
import { keys } from "../src/lib/kv-keys.js";
import { resolveCallRef } from "../src/lib/validate.js";
import { startRing, type StartRingResult } from "../src/lib/ringstart.js";
import type { RingJobs, RunRingDeps } from "../src/lib/ringrun.js";
import type { TelnyxClient } from "../src/lib/telnyx-api.js";
import type { RingDepsFactory } from "../src/routes/voice.js";
import { TOOLS, type ToolCtx, type ToolEnv, type ToolResult } from "../src/tools/index.js";

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

async function seeded(ringMode?: string, extra: Record<string, unknown> = {}) {
  const directory = new DirectoryActor(
    { storage: makeStorage() } as unknown as DCtor[0],
    {} as unknown as DCtor[1],
  );
  await directory.seed([
    { key: keys.flag("dispatch_enabled"), value: "true" },
    ...(ringMode === undefined
      ? []
      : [{ key: keys.flag("ring_mode"), value: ringMode }]),
  ]);
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

function handler(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} registered`);
  return t.handler;
}

const reserveArgs = (call_ref: string) => ({
  call_ref,
  customer_name: "Sam Rivera",
  address: "12 Banksia Street",
  callback_number: "0412 000 001",
  urgency: "emergency",
  trade: "plumbing",
  suburb: "Fitzroy",
  summary: "Burst pipe under the house",
});

const createArgs = (call_ref: string) => ({
  call_ref,
  customer_name: "Sam Rivera",
  address: "12 Banksia Street",
  details: "Burst pipe flooding the kitchen",
});

// Reserve + resolved actor name + a job-record view with the ring fields.
async function reserved(env: ToolEnv, call_ref: string) {
  const r = (await handler("reserve_technician")(reserveArgs(call_ref), env)) as ToolResult;
  assert.equal(r.ok, true, "reserve works");
  const { ref } = await resolveCallRef({ call_ref }, {});
  return { job_id: r.job_id as string, ref: ref as string };
}

interface RecView {
  dispatch_state?: string;
  ring_at?: number;
  ring_token?: string;
  ring_start_reason?: string;
  ring?: { status: string };
}

async function rec(env: ToolEnv, ref: string): Promise<RecView | null> {
  return (await env.JOBS?.idFromName(ref).get()) as unknown as RecView | null;
}

// Deps with the REAL JobActor pinned per call (so machine state is genuine)
// and a counting dialer; nothing else is real. Mirrors tests/ringstart.test.ts.
function makeDeps(env: ToolEnv, dialCalls: string[]): RingDepsFactory {
  const client: TelnyxClient = {
    dial: () => Promise.reject(new Error("runRing must use the injected dialer")),
    gatherUsingSpeak: () => Promise.resolve({ ok: true }),
    speak: () => Promise.resolve({ ok: true }),
    hangup: () => Promise.resolve({ ok: true }),
  };
  return (_e, c): RunRingDeps => ({
    jobs: env.JOBS?.idFromName(c) as unknown as RingJobs,
    tech: () => ({
      status: () => Promise.resolve({ status: "held" }),
      reserve: () => Promise.resolve({ ok: true, expires_at: Date.now() + 60_000 }),
      extendHold: () => Promise.resolve({ extended: true }),
      release: () => Promise.resolve({ released: true }),
      dispatch: () => Promise.resolve({ ok: true, until: Date.now() + 60_000 }),
    }),
    client,
    dialer: (to: string) => {
      dialCalls.push(to);
      return Promise.resolve({ ok: true, call_control_id: "cc-fake-" + String(dialCalls.length) });
    },
    phones: { phones: { "tech-01": "61400000001", "tech-03": "61400000003" }, invalid: [] },
    voice: "Telnyx.KokoroTTS.af",
    language: "en-AU",
    holdTtlS: 60,
    busyS: 1800,
  });
}

const spoken = (job_id: string) => job_id.split("").join(" ");

test("inline start succeeds: ok result, ring dialing, alarm ring cancelled", async () => {
  const { env } = await seeded("live");
  const { job_id, ref } = await reserved(env, "ri-ok-1");
  const dialCalls: string[] = [];
  const ctx: ToolCtx = { env, ringDepsFor: makeDeps(env, dialCalls) };
  const c = await handler("create_job")(createArgs("ri-ok-1"), env, ctx);
  assert.deepEqual(c, { ok: true, job_id, reference_spoken: spoken(job_id) });
  assert.deepEqual(dialCalls, ["61400000001"], "the reserved technician is dialled inline");
  const r = await rec(env, ref);
  assert.equal(r?.ring?.status, "dialing", "ring state set on the job");
  assert.equal(r?.dispatch_state, "ringing");
  assert.equal(r?.ring_start_reason, "ok");
  assert.equal(r?.ring_at, undefined, "pending alarm ring cancelled");
  assert.equal(r?.ring_token, undefined, "single-use token gone");
});

test("inline not started: mode_off and capped stay ok and record the reason", async () => {
  const off = await seeded("off");
  const r1 = await reserved(off.env, "ri-off-1");
  const c1 = await handler("create_job")(createArgs("ri-off-1"), off.env, { env: off.env });
  assert.deepEqual(c1, {
    ok: true,
    job_id: r1.job_id,
    reference_spoken: spoken(r1.job_id),
  });
  const offRec = await rec(off.env, r1.ref);
  assert.equal(offRec?.ring_start_reason, "mode_off");
  assert.equal(offRec?.dispatch_state, undefined, "mode_off is not unassigned (D20-5d rule)");
  assert.equal(offRec?.ring_at, undefined, "no alarm fallback for mode_off");
  assert.equal(offRec?.ring, undefined, "off never feeds the machine");

  // Cap of 1 already consumed: the daily cap blocks the start (dry_run dir).
  const cap = await seeded(undefined, { RING_DAILY_CAP: "1" });
  assert.deepEqual(await cap.directory.bumpCounter("ring", 1), { ok: true, count: 1 });
  const r2 = await reserved(cap.env, "ri-cap-1");
  const c2 = await handler("create_job")(createArgs("ri-cap-1"), cap.env, { env: cap.env });
  assert.equal(c2.ok, true);
  const capRec = await rec(cap.env, r2.ref);
  assert.equal(capRec?.ring_start_reason, "capped");
  assert.equal(capRec?.dispatch_state, "unassigned", "the empty start ends exhausted");
  assert.equal(capRec?.ring?.status, "exhausted");
  assert.equal(capRec?.ring_at, undefined, "a start (even capped) cancels the alarm ring");
});

test("startRing throws: create_job still ok, unassigned, fallback alarm kept", async () => {
  const { env } = await seeded();
  const { job_id, ref } = await reserved(env, "ri-throw-1");
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m: unknown) => logs.push(String(m));
  try {
    const ctx: ToolCtx = {
      env,
      startRingFn: () => Promise.reject(new TypeError("boom-secret-payload")),
    };
    const c = await handler("create_job")(createArgs("ri-throw-1"), env, ctx);
    assert.deepEqual(c, { ok: true, job_id, reference_spoken: spoken(job_id) });
  } finally {
    console.log = orig;
  }
  const r = await rec(env, ref);
  assert.equal(r?.ring_start_reason, "run_error");
  assert.equal(r?.dispatch_state, "unassigned");
  assert.ok((r?.ring_at ?? 0) > Date.now(), "deps/run_error keeps the alarm fallback");
  assert.match(r?.ring_token ?? "", /^[0-9a-f]{32}$/, "fresh single-use token stored");
  assert.ok(!logs.join("\n").includes("boom-secret-payload"), "error message never logged");
});

test("startRing hangs: create_job returns within the cap and still ok", async () => {
  const { env } = await seeded();
  const { job_id, ref } = await reserved(env, "ri-hang-1");
  const ctx: ToolCtx = {
    env,
    ringTimeoutMs: 50, // injectable cap; the default is 3000 ms
    startRingFn: () => new Promise<StartRingResult>(() => {}), // never settles
  };
  const t0 = Date.now();
  const c = await handler("create_job")(createArgs("ri-hang-1"), env, ctx);
  const elapsed = Date.now() - t0;
  assert.deepEqual(c, { ok: true, job_id, reference_spoken: spoken(job_id) });
  assert.ok(elapsed >= 40 && elapsed < 1500, `cap held, got ${String(elapsed)} ms`);
  const r = await rec(env, ref);
  assert.equal(r?.ring_start_reason, "run_error", "a timeout counts as run_error");
  assert.equal(r?.dispatch_state, "unassigned");
  assert.ok((r?.ring_at ?? 0) > Date.now(), "timeout keeps the alarm fallback");
});

test("RING_INLINE=0: old alarm path only, no inline call", async () => {
  const { env } = await seeded("live");
  env.RING_INLINE = "0";
  const { job_id, ref } = await reserved(env, "ri-old-1");
  let inlineCalls = 0;
  const ctx: ToolCtx = {
    env,
    origin: "https://fn.example",
    startRingFn: () => {
      inlineCalls += 1;
      return Promise.resolve({ mode: "dry_run", started: true, reason: "ok" });
    },
  };
  const c = await handler("create_job")(createArgs("ri-old-1"), env, ctx);
  assert.deepEqual(c, { ok: true, job_id, reference_spoken: spoken(job_id) });
  assert.equal(inlineCalls, 0, "startRing never called on the 0 path");
  const r = await rec(env, ref);
  const delay = (r?.ring_at ?? NaN) - Date.now();
  assert.ok(delay <= 1000 && delay > -2000, `ring_at about 1s out, got ${String(delay)}`);
  assert.match(r?.ring_token ?? "", /^[0-9a-f]{32}$/);
  assert.equal(r?.ring_start_reason, undefined, "nothing stamped before the alarm");
  assert.equal(r?.dispatch_state, undefined);
});

test("double start: the alarm path after an inline start never dials twice", async () => {
  const { env } = await seeded("live");
  const { ref } = await reserved(env, "ri-dbl-1");
  const dialCalls: string[] = [];
  const ctx: ToolCtx = { env, ringDepsFor: makeDeps(env, dialCalls) };
  const c = await handler("create_job")(createArgs("ri-dbl-1"), env, ctx);
  assert.equal(c.ok, true);
  assert.equal(dialCalls.length, 1, "inline dial happened once");

  const actor = env.JOBS?.idFromName(ref) as unknown as {
    consumeRingToken(token: string): Promise<boolean>;
    alarm(): Promise<void>;
  };
  // The callback route's gate: token gone and ring not idle -> always false.
  assert.equal(await actor.consumeRingToken("0".repeat(32)), false, "token replay refused");

  // A redelivered alarm: ring_at was cancelled, so it never POSTs (fetch would throw).
  const origFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = ((..._a: unknown[]) => {
    fetches += 1;
    return Promise.reject(new Error("no network in tests"));
  }) as typeof fetch;
  try {
    await actor.alarm();
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(fetches, 0, "no callback POST after the inline start");

  // Even a full second startRing on the same job is a reducer no-op.
  await startRing(env as unknown as Parameters<typeof startRing>[0], ref, {
    depsFor: makeDeps(env, dialCalls),
  });
  assert.equal(dialCalls.length, 1, "still one dial total");
});
