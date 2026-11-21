// tests/ringrun.test.ts
// D20-4a harness tests: fakes only, no network, no real actors. The fake jobs
// stub applies the REAL reducer (reduceRing) so machine behaviour is genuine;
// only the I/O is fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runRing,
  RING_RUN_MAX_ITERATIONS,
  type RingJob,
  type RunRingDeps,
} from "../src/lib/ringrun.js";
import {
  initRingState,
  reduceRing,
  type DialResult,
  type RingEffect,
  type RingEvent,
  type RingState,
} from "../src/lib/ring.js";
import { decodeClientState, type TelnyxClient } from "../src/lib/telnyx-api.js";

const JOB: RingJob = {
  job_id: "JA4F7C",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Richmond",
  summary: "Burst pipe in the kitchen",
  customer_name: "Sam",
  address: "12 Example St",
  contact_phone: "61412345678",
};

const CC1 = "cc-61400000001";
const CC2 = "cc-61400000002";

// --- fakes -------------------------------------------------------------------

interface TechCalls {
  reserve: Record<string, unknown>[];
  extendHold: Record<string, unknown>[];
  release: Record<string, unknown>[];
  dispatch: Record<string, unknown>[];
}

function makeJobs(order: string[], job: RingJob | null = JOB, ring: RingState = initRingState()) {
  const ringEvents: RingEvent[] = [];
  const effectBatches: RingEffect[][] = [];
  let gets = 0;
  const jobs = {
    async ringEvent(event: RingEvent) {
      ringEvents.push(event);
      order.push("ringEvent:" + event.type);
      const [next, effects] = reduceRing(ring, event);
      ring = next;
      effectBatches.push(effects);
      return { state: ring, effects };
    },
    async get() {
      gets += 1;
      return job === null ? null : { ...job, ring };
    },
  };
  return { jobs, ringEvents, effectBatches, gets: () => gets, state: () => ring };
}

function makeTech(order: string[], opts: { reserveFailIds?: string[]; releaseThrowIds?: string[] } = {}) {
  const calls = new Map<string, TechCalls>();
  const rec = (id: string): TechCalls => {
    const cur = calls.get(id) ?? { reserve: [], extendHold: [], release: [], dispatch: [] };
    calls.set(id, cur);
    return cur;
  };
  const tech = (id: string) => ({
    reserve: async (args: { call_ref: string; job_id: string; ttl_s?: number }) => {
      rec(id).reserve.push(args);
      order.push("reserve:" + id);
      if (opts.reserveFailIds?.includes(id)) return { ok: false, reason: "busy" as const };
      return { ok: true as const, expires_at: 1 };
    },
    extendHold: async (args: { call_ref: string; job_id: string; ttl_s?: number }) => {
      rec(id).extendHold.push(args);
      order.push("extend_hold:" + id);
      return { extended: true };
    },
    release: async (args: { call_ref: string; job_id: string }) => {
      rec(id).release.push(args);
      order.push("release:" + id);
      if (opts.releaseThrowIds?.includes(id)) throw new Error("boom");
      return { released: true };
    },
    dispatch: async (args: { call_ref: string; job_id: string; busy_s?: number }) => {
      rec(id).dispatch.push(args);
      order.push("dispatch:" + id);
      return { ok: true as const, until: 1 };
    },
  });
  return { tech, calls };
}

function makeClient(order: string[], opts: { gatherOk?: boolean } = {}) {
  const gather: { ccid: string; payload: string }[] = [];
  const speak: { ccid: string; payload: string }[] = [];
  const hangup: string[] = [];
  const client: TelnyxClient = {
    async dial() {
      throw new Error("runRing must go through the injected dialer, not client.dial");
    },
    async gatherUsingSpeak(ccid, o) {
      gather.push({ ccid, payload: o.payload });
      order.push("gather:" + ccid);
      return opts.gatherOk === false ? { ok: false, reason: "http_5xx" } : { ok: true };
    },
    async speak(ccid, o) {
      speak.push({ ccid, payload: o.payload });
      order.push("speak:" + ccid);
      return { ok: true };
    },
    async hangup(ccid) {
      hangup.push(ccid);
      order.push("hangup:" + ccid);
      return { ok: true };
    },
  };
  return { client, gather, speak, hangup };
}

function makeDialer(order: string[], results: Record<string, DialResult> = {}) {
  const calls: { to: string; opts?: { client_state?: string; command_id?: string } }[] = [];
  const dialer = async (
    to: string,
    opts?: { client_state?: string; command_id?: string },
  ): Promise<DialResult> => {
    calls.push({ to, ...(opts !== undefined ? { opts } : {}) });
    order.push("dial:" + to);
    return results[to] ?? { ok: true, call_control_id: "cc-" + to };
  };
  return { dialer, calls };
}

function captureLogs() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.log = orig) };
}

function makeWorld(opts: {
  job?: RingJob | null;
  reserveFailIds?: string[];
  releaseThrowIds?: string[];
  gatherOk?: boolean;
  dialResults?: Record<string, DialResult>;
  phones?: RunRingDeps["phones"];
} = {}) {
  const order: string[] = [];
  const cap = captureLogs();
  const jobsF = makeJobs(order, opts.job === undefined ? JOB : opts.job);
  const techF = makeTech(order, { reserveFailIds: opts.reserveFailIds, releaseThrowIds: opts.releaseThrowIds });
  const clientF = makeClient(order, { gatherOk: opts.gatherOk });
  const dialerF = makeDialer(order, opts.dialResults);
  const phones = opts.phones ?? { phones: { t1: "61400000001", t2: "61400000002", t3: "61400000003" }, invalid: [] };
  const deps: RunRingDeps = {
    jobs: jobsF.jobs,
    tech: techF.tech,
    client: clientF.client,
    dialer: dialerF.dialer,
    phones,
    voice: "Telnyx.KokoroTTS.af",
    language: "en-AU",
    holdTtlS: 60,
    busyS: 1800,
  };
  return { order, cap, jobsF, techF, clientF, dialerF, deps };
}

const start = (candidates: string[]): RingEvent => ({ type: "start", mode: "live", candidates, now: 1 });
const answered = (ccid: string, eventId: string): RingEvent => ({ type: "answered", call_control_id: ccid, event_id: eventId, now: 2 });
const gatherEv = (ccid: string, digits: string, eventId: string): RingEvent => ({ type: "gather", call_control_id: ccid, digits, event_id: eventId, now: 3 });

/** start -> answered, prompting t1 (dial_result fed back internally). */
async function toPrompting(w: ReturnType<typeof makeWorld>, candidates: string[] = ["t1", "t2"]) {
  await runRing(w.deps, "call-C1", start(candidates));
  await runRing(w.deps, "call-C1", answered(CC1, "e1"));
}

// --- tests -------------------------------------------------------------------

test("happy path: start -> answer -> accept dispatches and speaks the confirmation", async () => {
  const w = makeWorld();
  try {
    await runRing(w.deps, "call-C1", start(["t1", "t2"]));
    // dial: t1 digits, client_state cites the call actor + job + tech + attempt
    assert.equal(w.dialerF.calls.length, 1);
    assert.equal(w.dialerF.calls[0].to, "61400000001");
    assert.deepEqual(decodeClientState(w.dialerF.calls[0].opts!.client_state!), {
      c: "call-C1",
      j: "JA4F7C",
      t: "t1",
      a: 1,
    });
    assert.equal(w.dialerF.calls[0].opts!.command_id, "ring-JA4F7C-1");
    assert.deepEqual(w.techF.calls.get("t1")!.extendHold, [{ call_ref: "call-C1", job_id: "JA4F7C", ttl_s: 60 }]);

    await runRing(w.deps, "call-C1", answered(CC1, "e1"));
    assert.equal(w.clientF.gather.length, 1);
    assert.equal(w.clientF.gather[0].ccid, CC1);
    assert.ok(w.clientF.gather[0].payload.includes("Press 1 to accept"));
    assert.ok(w.jobsF.gets() >= 2, "brief re-read the JobActor at gather_prompt");

    await runRing(w.deps, "call-C1", gatherEv(CC1, "1", "e2"));
    assert.deepEqual(w.techF.calls.get("t1")!.dispatch, [{ call_ref: "call-C1", job_id: "JA4F7C", busy_s: 1800 }]);
    assert.equal(w.techF.calls.get("t1")!.release.length, 0, "accepted technician never released");
    assert.equal(w.clientF.speak.length, 1);
    assert.equal(w.clientF.speak[0].ccid, CC1);
    assert.equal(
      w.clientF.speak[0].payload,
      "Thank you. The customer details will be sent to you by text message. Goodbye.",
    );
    assert.deepEqual(w.jobsF.ringEvents.map((e) => e.type), ["start", "dial_result", "answered", "gather"]);
    assert.equal(w.jobsF.state().status, "accepted");

    // logs: no phone digits, no brief text
    const out = w.cap.lines.join("\n");
    assert.ok(!out.includes("61400000001"), "no technician number in logs");
    assert.ok(!out.includes("Burst pipe"), "no brief text in logs");
    assert.ok(out.includes('"event":"ring_effect"'));
  } finally {
    w.cap.restore();
  }
});

test("effect order: extend_hold -> dial -> gather -> dispatch -> speak", async () => {
  const w = makeWorld();
  try {
    await toPrompting(w);
    await runRing(w.deps, "call-C1", gatherEv(CC1, "1", "e2"));
    const io = w.order.filter((s) => !s.startsWith("ringEvent"));
    assert.deepEqual(io, ["extend_hold:t1", "dial:61400000001", "gather:" + CC1, "dispatch:t1", "speak:" + CC1]);
  } finally {
    w.cap.restore();
  }
});

test("decline escalates to the second technician (release + decline speech + reserve + dial)", async () => {
  const w = makeWorld();
  try {
    await toPrompting(w);
    await runRing(w.deps, "call-C1", gatherEv(CC1, "2", "e2"));
    assert.deepEqual(w.techF.calls.get("t1")!.release, [{ call_ref: "call-C1", job_id: "JA4F7C" }]);
    assert.equal(w.clientF.speak.length, 1);
    assert.equal(w.clientF.speak[0].ccid, CC1);
    assert.equal(w.clientF.speak[0].payload, "No problem, thank you. Goodbye.");
    assert.deepEqual(w.clientF.hangup, [], "the decline hangup waits for speak.ended");
    assert.equal(w.jobsF.state().confirm_ccid, CC1);
    assert.deepEqual(w.techF.calls.get("t2")!.reserve, [{ call_ref: "call-C1", job_id: "JA4F7C", ttl_s: 60 }]);
    assert.deepEqual(w.techF.calls.get("t2")!.extendHold, [{ call_ref: "call-C1", job_id: "JA4F7C", ttl_s: 60 }]);
    assert.equal(w.dialerF.calls.length, 2);
    assert.equal(w.dialerF.calls[1].to, "61400000002");
    assert.deepEqual(decodeClientState(w.dialerF.calls[1].opts!.client_state!), {
      c: "call-C1",
      j: "JA4F7C",
      t: "t2",
      a: 2,
    });
    assert.equal(w.dialerF.calls[1].opts!.command_id, "ring-JA4F7C-2");
    assert.equal(w.jobsF.state().status, "dialing");
    assert.equal(w.jobsF.state().attempt, 2);
    assert.deepEqual(w.jobsF.state().tried, ["t1", "t2"]);
    assert.deepEqual(w.jobsF.ringEvents.map((e) => e.type), [
      "start", "dial_result", "answered", "gather", "reserve_result", "dial_result",
    ]);
    // release of t1 strictly before the reserve of t2
    assert.ok(w.order.indexOf("release:t1") < w.order.indexOf("reserve:t2"));
  } finally {
    w.cap.restore();
  }
});

test("reserve_result failure skips the candidate without using an attempt", async () => {
  const w = makeWorld({ reserveFailIds: ["t2"] });
  try {
    await toPrompting(w, ["t1", "t2", "t3"]);
    await runRing(w.deps, "call-C1", gatherEv(CC1, "2", "e2"));
    assert.equal(w.techF.calls.get("t2")!.reserve.length, 1);
    assert.equal(w.techF.calls.get("t3")!.reserve.length, 1);
    assert.equal(w.jobsF.state().status, "dialing");
    assert.equal(w.jobsF.state().attempt, 2, "t2's failed reserve consumed no attempt");
    assert.deepEqual(w.jobsF.state().tried, ["t1", "t2", "t3"]);
    assert.equal(w.jobsF.state().outcome_log.length, 1, "skip logs no outcome");
    assert.deepEqual(decodeClientState(w.dialerF.calls[1].opts!.client_state!), {
      c: "call-C1",
      j: "JA4F7C",
      t: "t3",
      a: 2,
    });
  } finally {
    w.cap.restore();
  }
});

test("missing phone: dialer never called, dial_failed outcome, exhausts alone", async () => {
  const w = makeWorld({ phones: { phones: {}, invalid: ["t1"] } });
  try {
    await runRing(w.deps, "call-C1", start(["t1"]));
    assert.equal(w.dialerF.calls.length, 0);
    assert.equal(w.jobsF.state().status, "exhausted");
    assert.equal(w.jobsF.state().outcome_log[0].outcome, "dial_failed");
    const out = w.cap.lines.join("\n");
    assert.ok(out.includes('"event":"ring_effect_fail"') && out.includes("no_phone"));
  } finally {
    w.cap.restore();
  }
});

test("dial failure releases and escalates with outcome dial_failed", async () => {
  const w = makeWorld({ dialResults: { "61400000001": { ok: false, reason: "network" } } });
  try {
    await runRing(w.deps, "call-C1", start(["t1", "t2"]));
    assert.deepEqual(w.techF.calls.get("t1")!.release, [{ call_ref: "call-C1", job_id: "JA4F7C" }]);
    assert.equal(w.clientF.hangup.length, 0, "no answered leg to hang up");
    assert.deepEqual(w.jobsF.state().outcome_log.map((o) => o.outcome), ["dial_failed"]);
    assert.equal(w.dialerF.calls.length, 2, "t2 dialled after t1 failed");
    assert.equal(w.jobsF.state().status, "dialing");
    assert.equal(w.jobsF.state().attempt, 2);
  } finally {
    w.cap.restore();
  }
});

test("gather command failure feeds sys-gather-fail event -> no_input -> escalation", async () => {
  const w = makeWorld({ gatherOk: false });
  try {
    await toPrompting(w, ["t1"]);
    const synth = w.jobsF.ringEvents.find((e) => e.type === "gather") as
      | { digits: string; event_id: string; call_control_id: string }
      | undefined;
    assert.ok(synth !== undefined);
    assert.equal(synth.digits, "");
    assert.equal(synth.event_id, "sys-gather-fail-1");
    assert.equal(synth.call_control_id, CC1);
    assert.deepEqual(w.jobsF.state().outcome_log.map((o) => o.outcome), ["no_input"]);
    assert.deepEqual(w.jobsF.state().status, "exhausted");
    assert.deepEqual(w.techF.calls.get("t1")!.release, [{ call_ref: "call-C1", job_id: "JA4F7C" }]);
    assert.deepEqual(w.clientF.hangup, [CC1], "answered leg hung up on no_input");
    const out = w.cap.lines.join("\n");
    assert.ok(out.includes("http_5xx"), "reason logged");
    assert.ok(!out.includes("Burst pipe"), "brief text never logged");
  } finally {
    w.cap.restore();
  }
});

test("two declines exhaust after 2 attempts with job_state unassigned", async () => {
  const w = makeWorld();
  try {
    await toPrompting(w);
    await runRing(w.deps, "call-C1", gatherEv(CC1, "2", "e2"));
    await runRing(w.deps, "call-C1", answered(CC2, "e3"));
    await runRing(w.deps, "call-C1", gatherEv(CC2, "2", "e4"));
    assert.equal(w.jobsF.state().status, "exhausted");
    assert.deepEqual(w.jobsF.state().outcome_log.map((o) => o.outcome), ["declined", "declined"]);
    assert.equal(w.techF.calls.get("t2")!.dispatch.length, 0);
    assert.deepEqual(
      w.clientF.speak.map((s) => s.ccid),
      [CC1, CC2],
      "both declines get the confirmation speech",
    );
    assert.deepEqual(w.clientF.hangup, [], "both decline hangups wait for speak.ended");
    assert.equal(w.jobsF.state().confirm_ccid, CC2);
    const flat = w.jobsF.effectBatches.flat();
    assert.ok(flat.some((e) => e.type === "job_state" && e.state === "unassigned"));
    const out = w.cap.lines.join("\n");
    assert.ok(out.includes("ring_exhausted"));
  } finally {
    w.cap.restore();
  }
});

test("feedback loop is bounded at RING_RUN_MAX_ITERATIONS", async () => {
  const order: string[] = [];
  const cap = captureLogs();
  try {
    // Pathological jobs stub: a dial effect on every event, forever.
    const badJobs = {
      ringEvents: [] as RingEvent[],
      async ringEvent(event: RingEvent) {
        badJobs.ringEvents.push(event);
        const state: RingState = {
          ...initRingState(),
          status: "dialing",
          attempt: 1,
          current: { technician_id: "t1", call_control_id: CC1, started_at: 0 },
        };
        return { state, effects: [{ type: "dial" as const, technician_id: "t1", attempt: 1 }] };
      },
      async get() {
        return JOB;
      },
    };
    const techF = makeTech(order);
    const clientF = makeClient(order);
    const dialerF = makeDialer(order);
    const deps: RunRingDeps = {
      jobs: badJobs,
      tech: techF.tech,
      client: clientF.client,
      dialer: dialerF.dialer,
      phones: { phones: { t1: "61400000001" }, invalid: [] },
      voice: "v",
      language: "en-AU",
      holdTtlS: 60,
      busyS: 1800,
    };
    await runRing(deps, "call-C1", start(["t1"]));
    assert.equal(badJobs.ringEvents.length, RING_RUN_MAX_ITERATIONS);
    assert.equal(dialerF.calls.length, RING_RUN_MAX_ITERATIONS);
    assert.ok(cap.lines.join("\n").includes("iteration_cap"));
  } finally {
    cap.restore();
  }
});

test("one failing effect never stops the rest and nothing throws", async () => {
  const w = makeWorld({ releaseThrowIds: ["t1"] });
  try {
    await toPrompting(w);
    await runRing(w.deps, "call-C1", gatherEv(CC1, "2", "e2")); // release t1 throws
    assert.equal(w.clientF.speak.length, 1, "decline speech still ran after release failed");
    assert.equal(w.techF.calls.get("t2")!.reserve.length, 1, "escalation still ran");
    assert.equal(w.dialerF.calls.length, 2, "t2 still dialled");
    assert.equal(w.jobsF.state().status, "dialing");
    const out = w.cap.lines.join("\n");
    assert.ok(out.includes('"event":"ring_effect_fail"') && out.includes("exception"));
  } finally {
    w.cap.restore();
  }
});
