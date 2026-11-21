// tests/ringtest.test.ts
// POST /admin/ring-test route tests: fake actors and an injected startRing;
// no network, no real numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleRingTest,
  type RingTestEnv,
  type RingTestJobs,
  type StartRingFn,
} from "../src/routes/ringtest.js";
import type { StartRingOpts } from "../src/lib/ringstart.js";
import type { RingTech } from "../src/lib/ringrun.js";
import type { RingEvent, RingEffect, RingState } from "../src/lib/ring.js";

const TOKEN = "ring-test-admin-token";

interface Calls {
  opens: Array<Record<string, unknown>>;
  reserves: Array<Record<string, unknown>>;
  releases: number;
  starts: Array<{ callActor: string; opts?: StartRingOpts }>;
}

function makeFakes(opts: { reserveOk?: boolean } = {}): {
  env: RingTestEnv;
  calls: Calls;
  startFn: StartRingFn;
} {
  const calls: Calls = { opens: [], reserves: [], releases: 0, starts: [] };
  const jobs: RingTestJobs = {
    open: async (args) => {
      calls.opens.push(args as Record<string, unknown>);
      return { ok: true };
    },
    get: async () => null,
    ringEvent: async (_event: RingEvent) =>
      ({ state: null, effects: [] }) as {
        state: RingState | null;
        effects: RingEffect[];
      },
  };
  const tech: RingTech = {
    reserve: async (args) => {
      calls.reserves.push(args as Record<string, unknown>);
      return opts.reserveOk === false ? { ok: false, reason: "busy" } : { ok: true };
    },
    release: async () => {
      calls.releases += 1;
      return { released: true };
    },
    extendHold: async () => ({ extended: true }),
    dispatch: async () => ({ ok: true }),
  };
  const env: RingTestEnv = {
    ADMIN_TOKEN: TOKEN,
    DIRECTORY: {
      idFromName: () => ({
        flag: async () => "off", // an "off" flag must NOT stop a ring test
        bumpCounter: async () => ({ ok: true, count: 1 }),
      }),
    },
    JOBS: { idFromName: () => jobs },
    TECH: { idFromName: () => tech },
  };
  const startFn: StartRingFn = async (_env, callActor, opts) => {
    calls.starts.push({ callActor, ...(opts !== undefined ? { opts } : {}) });
    return { mode: opts?.mode ?? "dry_run", started: true };
  };
  return { env, calls, startFn };
}

function req(body?: string, token?: string, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-admin-token"] = token;
  return new Request("https://test.invalid/admin/ring-test", { method, body, headers });
}

function captureLog(): { lines: Array<Record<string, unknown>>; restore: () => void } {
  const lines: Array<Record<string, unknown>> = [];
  const orig = console.log;
  console.log = (msg: unknown) => {
    lines.push(JSON.parse(String(msg)) as Record<string, unknown>);
  };
  return { lines, restore: () => (console.log = orig) };
}

test("auth: missing or wrong token -> 403 forbidden, no job created, no ring started", async () => {
  for (const token of [undefined, "wrong-token-xyz"]) {
    const { env, calls, startFn } = makeFakes();
    const cap = captureLog();
    try {
      const body = JSON.stringify({ technician_id: "tech-01" });
      const res = await handleRingTest(req(body, token), env, startFn);
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
      assert.equal(calls.opens.length, 0, "no job created");
      assert.equal(calls.reserves.length, 0, "no reservation");
      assert.equal(calls.starts.length, 0, "no ring started");
      const fail = cap.lines.find((l) => l.event === "ring_test_fail");
      assert.equal(fail?.outcome, "rejected");
    } finally {
      cap.restore();
    }
  }
});

test("unset ADMIN_TOKEN fails closed: 403", async () => {
  const { env, calls, startFn } = makeFakes();
  delete (env as Record<string, unknown>).ADMIN_TOKEN;
  const cap = captureLog();
  try {
    const body = JSON.stringify({ technician_id: "tech-01" });
    const res = await handleRingTest(req(body, TOKEN), env, startFn);
    assert.equal(res.status, 403);
    assert.equal(calls.opens.length, 0);
  } finally {
    cap.restore();
  }
});

test("bad bodies -> 400 bad_body, no actor touched", async () => {
  const { env, calls, startFn } = makeFakes();
  const cap = captureLog();
  try {
    const bads = [
      "{not json",
      JSON.stringify({}),
      JSON.stringify({ technician_id: "" }),
      JSON.stringify({ technician_id: "tech-01", trade: "carpentry" }),
      JSON.stringify({ technician_id: "tech-01", mode: "off" }),
      JSON.stringify({ technician_id: "tech-01", mode: "yolo" }),
    ];
    for (const b of bads) {
      const res = await handleRingTest(req(b, TOKEN), env, startFn);
      assert.equal(res.status, 400, b);
      assert.deepEqual(await res.json(), { ok: false, error: "bad_body" });
    }
    assert.equal(calls.opens.length, 0);
    assert.equal(calls.reserves.length, 0);
    assert.equal(calls.starts.length, 0);
  } finally {
    cap.restore();
  }
});

test("happy path: fake sim job opened, technician reserved, ring started", async () => {
  const { env, calls, startFn } = makeFakes();
  const cap = captureLog();
  try {
    const body = JSON.stringify({ technician_id: "tech-02", trade: "electrical" });
    const res = await handleRingTest(req(body, TOKEN), env, startFn);
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.ok, true);
    assert.match(String(json.call_ref), /^sim-/);
    assert.match(String(json.job_id), /^SIM-/);
    assert.equal(json.mode, "dry_run"); // default, never off and never live
    assert.equal(calls.reserves.length, 1);
    assert.equal(calls.reserves[0].call_ref, json.call_ref);
    assert.equal(calls.opens.length, 1);
    assert.equal(calls.opens[0].tech_id, "tech-02");
    assert.equal(calls.opens[0].trade, "electrical");
    assert.equal(calls.starts.length, 1);
    assert.equal(calls.starts[0].callActor, json.call_ref);
    assert.equal(calls.starts[0].opts?.mode, "dry_run");
  } finally {
    cap.restore();
  }
});

test("never live unless asked: default is dry_run even against a live/off flag", async () => {
  // env's flag fake returns "off"; startRing override must still be dry_run.
  const { env, calls, startFn } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleRingTest(
      req(JSON.stringify({ technician_id: "tech-01" }), TOKEN),
      env,
      startFn,
    );
    assert.equal(res.status, 200);
    assert.equal(calls.starts[0].opts?.mode, "dry_run");
  } finally {
    cap.restore();
  }
});

test("explicit mode live reaches startRing as live", async () => {
  const { env, calls, startFn } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleRingTest(
      req(JSON.stringify({ technician_id: "tech-01", mode: "live" }), TOKEN),
      env,
      startFn,
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.mode, "live");
    assert.equal(calls.starts[0].opts?.mode, "live");
  } finally {
    cap.restore();
  }
});

test("reserve failure: ok:false as data, no job opened, no ring started", async () => {
  const { env, calls, startFn } = makeFakes({ reserveOk: false });
  const cap = captureLog();
  try {
    const res = await handleRingTest(
      req(JSON.stringify({ technician_id: "tech-01" }), TOKEN),
      env,
      startFn,
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.ok, false);
    assert.equal(json.error, "reserve_failed");
    assert.equal(calls.opens.length, 0);
    assert.equal(calls.starts.length, 0);
  } finally {
    cap.restore();
  }
});
