// tests/ringstart.test.ts
// D20-5a startRing tests: fake actors only, the jobs stub applies the REAL
// reducer so machine behaviour is genuine. No network, no real phone numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startRing, type StartRingEnv } from "../src/lib/ringstart.js";
import {
  initRingState,
  reduceRing,
  type RingEvent,
  type RingState,
} from "../src/lib/ring.js";
import type { RingJob, RunRingDeps } from "../src/lib/ringrun.js";
import type { TelnyxClient } from "../src/lib/telnyx-api.js";

type SimJob = RingJob & { tech_id?: unknown };

interface World {
  env: StartRingEnv;
  depsFor: () => RunRingDeps;
  ringEvents: RingEvent[];
  state: () => RingState;
  dialCalls: { to: string }[];
  bumpCalls: { name: string; cap: number }[];
  logs: Array<Record<string, unknown>>;
  restore: () => void;
}

function makeWorld(
  opts: {
    flag?: string | null;
    capHit?: boolean;
    job?: SimJob | null;
    lastRingAt?: Record<string, number>;
    config?: Record<string, string>;
    phones?: Record<string, string>;
  } = {},
): World {
  let ring = initRingState();
  const ringEvents: RingEvent[] = [];
  const dialCalls: { to: string }[] = [];
  const bumpCalls: { name: string; cap: number }[] = [];
  const job: SimJob | null =
    opts.job === undefined
      ? {
          job_id: "JA4SIM",
          urgency: "urgent",
          trade: "plumbing",
          suburb: "Richmond",
          summary: "Burst pipe",
          tech_id: "tech-03",
        }
      : opts.job;

  const logs: Array<Record<string, unknown>> = [];
  const orig = console.log;
  console.log = (msg: unknown) => {
    logs.push(JSON.parse(String(msg)) as Record<string, unknown>);
  };

  const client: TelnyxClient = {
    async dial() {
      throw new Error("runRing must use the injected dialer");
    },
    async gatherUsingSpeak() {
      return { ok: true };
    },
    async speak() {
      return { ok: true };
    },
    async hangup() {
      return { ok: true };
    },
  };

  const deps: RunRingDeps = {
    jobs: {
      async ringEvent(event: RingEvent) {
        ringEvents.push(event);
        const [next, effects] = reduceRing(ring, event);
        ring = next;
        return { state: ring, effects };
      },
      async get() {
        return job === null ? null : ({ ...job, ring } as RingJob);
      },
    },
    tech: (id: string) => ({
      status: async () =>
        opts.lastRingAt?.[id] === undefined
          ? undefined
          : { last_ring_at: opts.lastRingAt[id] },
      reserve: async () => ({ ok: true, expires_at: 1 }),
      extendHold: async () => ({ extended: true }),
      release: async () => ({ released: true }),
      dispatch: async () => ({ ok: true, until: 1 }),
    }),
    client,
    dialer: async (to: string) => {
      dialCalls.push({ to });
      return { ok: true, call_control_id: "cc-" + to };
    },
    phones: {
      phones: opts.phones ?? { "tech-03": "61400000003", "tech-01": "61400000001" },
      invalid: [],
    },
    voice: "Telnyx.KokoroTTS.af",
    language: "en-AU",
    holdTtlS: 60,
    busyS: 1800,
  };

  const env: StartRingEnv = {
    ...(opts.config ?? {}),
    DIRECTORY: {
      idFromName: () => ({
        flag: async (name: string) =>
          name === "ring_mode" ? (opts.flag ?? null) : null,
        bumpCounter: async (name: string, cap: number) => {
          bumpCalls.push({ name, cap });
          return opts.capHit === true ? { ok: false, count: cap } : { ok: true, count: 1 };
        },
      }),
    },
  };
  const depsFor = (): RunRingDeps => deps;
  return {
    env,
    depsFor,
    ringEvents,
    state: () => ring,
    dialCalls,
    bumpCalls,
    logs,
    restore: () => {
      console.log = orig;
    },
  };
}

function startMode(w: World): string | undefined {
  const ev = w.ringEvents[0];
  return ev !== undefined && ev.type === "start" ? ev.mode : undefined;
}

test("mode resolution: missing/off/dry_run/live/garbage -> flag rules (1.7)", async () => {
  const cases: Array<{ flag: string | null; wantMode: string; started: boolean }> = [
    { flag: null, wantMode: "dry_run", started: true },
    { flag: "off", wantMode: "off", started: false },
    { flag: "dry_run", wantMode: "dry_run", started: true },
    { flag: "live", wantMode: "live", started: true },
    { flag: "banana", wantMode: "dry_run", started: true },
    { flag: "LIVE", wantMode: "dry_run", started: true }, // exact match only
  ];
  for (const c of cases) {
    const w = makeWorld({ flag: c.flag });
    try {
      const r = await startRing(w.env, "call-SIM", {
        now: 1000,
        depsFor: w.depsFor,
      });
      assert.equal(r.mode, c.wantMode, `flag ${String(c.flag)}`);
      assert.equal(r.started, c.started, `flag ${String(c.flag)}`);
      if (c.wantMode === "off") {
        assert.equal(w.ringEvents.length, 0, "off never feeds an event");
        assert.ok(
          w.logs.some((l) => l.event === "ring_start" && l.node === "off"),
          "off logs ring_start",
        );
        assert.equal(w.bumpCalls.length, 0, "off never touches the cap");
      } else {
        assert.equal(startMode(w), c.wantMode, `flag ${String(c.flag)}`);
      }
    } finally {
      w.restore();
    }
  }
});

test("override beats the flag and can never produce off (ring-test)", async () => {
  for (const flag of ["off", "live", null] as const) {
    const w = makeWorld({ flag });
    try {
      const r = await startRing(w.env, "call-SIM", {
        mode: "dry_run",
        now: 1000,
        depsFor: w.depsFor,
      });
      assert.equal(r.mode, "dry_run", `flag ${String(flag)} overridden`);
      assert.equal(startMode(w), "dry_run");
    } finally {
      w.restore();
    }
  }
});

test("cap hit: ring_capped log, empty candidates, job ends exhausted", async () => {
  const w = makeWorld({ flag: "live", capHit: true });
  try {
    const r = await startRing(w.env, "call-SIM", { now: 1000, depsFor: w.depsFor });
    assert.equal(r.mode, "live");
    assert.equal(r.started, true);
    assert.deepEqual(w.bumpCalls, [{ name: "ring", cap: 20 }]);
    const ev = w.ringEvents[0];
    assert.ok(ev !== undefined && ev.type === "start");
    assert.deepEqual(ev.candidates, []);
    assert.equal(w.state().status, "exhausted");
    assert.equal(w.dialCalls.length, 0, "capped ring never dials");
    assert.ok(w.logs.some((l) => l.event === "ring_capped"), "ring_capped logged");
    assert.ok(w.logs.some((l) => l.event === "ring_exhausted"), "ending logged");
    assert.ok(w.logs.every((l) => String(l.technician_id ?? "") !== "tech-03"), "no technician dialled");
  } finally {
    w.restore();
  }
});

test("daily cap invalid values fall back to 20; a valid value is honoured", async () => {
  const w = makeWorld({ flag: "dry_run", config: { RING_DAILY_CAP: "7" } });
  try {
    await startRing(w.env, "call-SIM", { now: 1000, depsFor: w.depsFor });
    assert.deepEqual(w.bumpCalls, [{ name: "ring", cap: 7 }]);
  } finally {
    w.restore();
  }
  const bad = makeWorld({ flag: "dry_run", config: { RING_DAILY_CAP: "9999" } });
  try {
    await startRing(bad.env, "call-SIM", { now: 1000, depsFor: bad.depsFor });
    assert.deepEqual(bad.bumpCalls, [{ name: "ring", cap: 20 }]);
  } finally {
    bad.restore();
  }
});

test("candidates: reserved technician first, trade walk after, no dup, other trade excluded", async () => {
  const w = makeWorld({ flag: "dry_run" }); // job: tech-03, plumbing
  try {
    await startRing(w.env, "call-SIM", { now: 1000, depsFor: w.depsFor });
    const ev = w.ringEvents[0];
    assert.ok(ev !== undefined && ev.type === "start");
    // tech-03 (plumbing/other) reserved first; plumbing walk adds tech-01;
    // tech-02 (electrical/hvac) excluded; no duplicate of tech-03.
    assert.deepEqual(ev.candidates, ["tech-03", "tech-01"]);
    assert.deepEqual(w.state().candidates, ["tech-03", "tech-01"]);
  } finally {
    w.restore();
  }
});

test("missing job record: empty candidates, exhausted, never throws", async () => {
  const w = makeWorld({ flag: "live", job: null });
  try {
    const r = await startRing(w.env, "call-SIM", { now: 1000, depsFor: w.depsFor });
    assert.equal(r.started, true);
    const ev = w.ringEvents[0];
    assert.ok(ev !== undefined && ev.type === "start");
    assert.deepEqual(ev.candidates, []);
  } finally {
    w.restore();
  }
});

test("cooldown: a technician rung inside RING_COOLDOWN_S drops out; 0 disables", async () => {
  const recent = makeWorld({
    flag: "dry_run",
    lastRingAt: { "tech-03": 900 }, // now is 1000 -> 100 ms ago
  });
  try {
    await startRing(recent.env, "call-SIM", { now: 1000, depsFor: recent.depsFor });
    const ev = recent.ringEvents[0];
    assert.ok(ev !== undefined && ev.type === "start");
    assert.deepEqual(ev.candidates, ["tech-01"], "cooled-down reserved tech skipped");
  } finally {
    recent.restore();
  }

  const off = makeWorld({
    flag: "dry_run",
    lastRingAt: { "tech-03": 900 },
    config: { RING_COOLDOWN_S: "0" },
  });
  try {
    await startRing(off.env, "call-SIM", { now: 1000, depsFor: off.depsFor });
    const ev = off.ringEvents[0];
    assert.ok(ev !== undefined && ev.type === "start");
    assert.deepEqual(ev.candidates, ["tech-03", "tech-01"], "cooldown disabled");
  } finally {
    off.restore();
  }
});

test("live start dials the reserved technician; no phone number appears in any log line", async () => {
  const w = makeWorld({ flag: "live" });
  try {
    const r = await startRing(w.env, "call-SIM", { now: 1000, depsFor: w.depsFor });
    assert.equal(r.mode, "live");
    assert.deepEqual(w.dialCalls, [{ to: "61400000003" }], "dialled the reserved tech");
    assert.equal(w.state().status, "dialing");
    const joined = w.logs.map((l) => JSON.stringify(l)).join("\n");
    assert.ok(!joined.includes("61400000003"), "no technician number in logs");
    assert.ok(!joined.includes("61400000001"), "no other number in logs");
    assert.ok(w.logs.some((l) => l.event === "ring_start" && l.technician_id === "tech-03"));
  } finally {
    w.restore();
  }
});
