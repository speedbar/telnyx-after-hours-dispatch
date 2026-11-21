// tests/managersms.test.ts
// D20c: one idempotent SMS to the manager when nobody accepts (ring exhausted
// or a no_candidates start). Fakes only, no network; the jobs stub applies
// the REAL reducer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManagerSms,
  SMS_MAX_LEN,
  type AcceptSmsJob,
} from "../src/lib/sms.js";
import {
  initRingState,
  reduceRing,
  type DialResult,
  type RingEvent,
  type RingState,
} from "../src/lib/ring.js";
import { runRing, type RingJob, type RunRingDeps } from "../src/lib/ringrun.js";
import { startRing, type StartRingEnv } from "../src/lib/ringstart.js";
import type { TelnyxClient } from "../src/lib/telnyx-api.js";

const MANAGER = "61400000099";
const JOB: RingJob = {
  job_id: "JA4F7C",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Richmond",
  summary: "Burst pipe in the kitchen",
  customer_name: "Sam Chen",
  address: "12 Example St",
  contact_phone: "61412345678",
  details: "Burst pipe under the kitchen sink",
};
const CC1 = "cc-61400000001";
const start = (c: string[]): RingEvent => ({ type: "start", mode: "live", candidates: c, now: 1 });
const answered = (): RingEvent => ({ type: "answered", call_control_id: CC1, event_id: "e1", now: 2 });
const gather = (digits: string): RingEvent => ({ type: "gather", call_control_id: CC1, digits, event_id: "e2", now: 3 });

function prompting(c: string[] = ["t1", "t2"]): RingState {
  let s = reduceRing(initRingState(), start(c))[0];
  s = reduceRing(s, { type: "dial_result", ok: true, call_control_id: CC1, now: 2 })[0];
  s = reduceRing(s, answered())[0];
  return s;
}

// --- reducer (pure) ----------------------------------------------------------

test("reducer: exhaustion emits sms_manager exactly once", () => {
  let s = prompting(["t1", "t2"]);
  const [s1, eff1] = reduceRing(s, gather("2"));
  assert.ok(!eff1.some((e) => e.type === "sms_manager"), "decline with a next candidate: none");
  s = reduceRing(s1, { type: "reserve_result", technician_id: "t2", ok: true, now: 4 })[0];
  s = reduceRing(s, { type: "dial_result", ok: true, call_control_id: "cc-2", now: 5 })[0];
  s = reduceRing(s, { type: "answered", call_control_id: "cc-2", event_id: "e3", now: 6 })[0];
  const [s5, eff5] = reduceRing(s, {
    type: "gather", call_control_id: "cc-2", digits: "2", event_id: "e4", now: 7,
  });
  assert.equal(s5.status, "exhausted");
  assert.equal(eff5.filter((e) => e.type === "sms_manager").length, 1, "exactly once at exhaustion");
});

test("reducer: accept and no_input with a next candidate emit no sms_manager", () => {
  const [, acc] = reduceRing(prompting(), gather("1"));
  assert.ok(!acc.some((e) => e.type === "sms_manager"), "accept: none");
  const [, ninp] = reduceRing(prompting(), gather(""));
  assert.ok(!ninp.some((e) => e.type === "sms_manager"), "no_input with a next candidate: none");
  // The reducer's own empty start is ringstart's path: no effect, no double text.
  const [, empty] = reduceRing(initRingState(), start([]));
  assert.ok(!empty.some((e) => e.type === "sms_manager"), "no_candidates start: none");
});

// --- runner (fakes) ----------------------------------------------------------

function captureLogs() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.log = orig) };
}

function makeWorld(opts: {
  mode?: "off" | "dry_run" | "live";
  capOk?: boolean;
  sendResult?: { ok: boolean; reason?: "http_4xx" | "http_5xx" | "timeout" | "network" | "no_key" | "no_config" };
  sendThrow?: boolean;
  manager?: string;
  job?: RingJob;
} = {}) {
  const cap = captureLogs();
  let ring: RingState = initRingState();
  let managerStatus: string | undefined;
  const sent: { to: string; text: string }[] = [];
  const stamps: { status: string; at: number }[] = [];
  const jobs = {
    async ringEvent(event: RingEvent) {
      const [next, effects] = reduceRing(ring, event);
      ring = next;
      return { state: ring, effects };
    },
    async get() {
      return {
        ...(opts.job ?? JOB),
        ring,
        ...(managerStatus !== undefined ? { manager_sms_status: managerStatus } : {}),
      };
    },
    async managerSmsDone(args: { status: string; at: number }) {
      stamps.push(args);
      managerStatus = args.status;
      return { ok: true };
    },
  };
  const tech = (_id: string) => ({
    reserve: async () => ({ ok: true as const }),
    extendHold: async () => ({ extended: true }),
    release: async () => ({ released: true }),
    dispatch: async () => ({ ok: true as const }),
  });
  const client: TelnyxClient = {
    async dial() {
      throw new Error("unneeded");
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
  const dialer = async (): Promise<DialResult> => ({ ok: true, call_control_id: CC1 });
  const deps: RunRingDeps = {
    jobs,
    tech,
    client,
    dialer,
    phones: { phones: { t1: "61400000001" }, invalid: [] },
    voice: "v",
    language: "en-AU",
    holdTtlS: 60,
    busyS: 1800,
    sms: {
      readMode: async () => opts.mode ?? "live",
      bumpCap: async () => opts.capOk ?? true,
      prefixes: ["+61"],
      send: async (to, text) => {
        if (opts.sendThrow === true) throw new Error("boom");
        sent.push({ to, text });
        return opts.sendResult ?? { ok: true };
      },
      ...(opts.manager !== undefined ? { managerPhone: opts.manager } : {}),
    },
  };
  return {
    deps,
    sent,
    stamps,
    cap,
    state: () => ring,
    setRing: (s: RingState) => {
      ring = s;
    },
    async toExhausted() {
      await runRing(deps, "call-C1", start(["t1"]));
      await runRing(deps, "call-C1", answered());
      await runRing(deps, "call-C1", gather("2")); // the only candidate declines
    },
  };
}

test("runner live: sends once to MANAGER_PHONE with ref, UNASSIGNED, name, phone, address", async () => {
  const w = makeWorld({ mode: "live", manager: MANAGER });
  try {
    await w.toExhausted();
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].to, "+61400000099");
    const body = w.sent[0].text;
    assert.ok(body.includes("JA4F7C") && body.includes("UNASSIGNED"), "ref + UNASSIGNED header");
    assert.ok(body.includes("Nobody accepted. Emergency plumber"));
    assert.ok(body.includes("Customer: Sam Chen"), "customer name texted");
    assert.ok(body.includes("Phone: 0412345678"), "callback in local form");
    assert.ok(body.includes("Address: 12 Example St, Richmond"), "address texted, suburb once");
    assert.ok(body.endsWith("Do not reply."));
    assert.ok(body.length <= SMS_MAX_LEN);
    assert.deepEqual(w.stamps.map((s) => s.status), ["sent"]);
    assert.equal(w.state().status, "exhausted");
    assert.ok(w.cap.lines.join("\n").includes('"event":"sms_sent"'));
  } finally {
    w.cap.restore();
  }
});

test("runner dry_run and off: the API is never called", async () => {
  for (const [mode, status, marker] of [
    ["dry_run", "dry_run", "sms_dry_run"],
    ["off", "off", "sms_skipped"],
  ] as const) {
    const w = makeWorld({ mode, manager: MANAGER });
    try {
      await w.toExhausted();
      assert.equal(w.sent.length, 0, mode);
      assert.deepEqual(w.stamps.map((s) => s.status), [status]);
      assert.ok(w.cap.lines.join("\n").includes(`"event":"${marker}"`));
      assert.equal(w.state().status, "exhausted");
    } finally {
      w.cap.restore();
    }
  }
});

test("runner capped: daily cap hit skips the send", async () => {
  const w = makeWorld({ mode: "live", capOk: false, manager: MANAGER });
  try {
    await w.toExhausted();
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.stamps.map((s) => s.status), ["capped"]);
    assert.ok(w.cap.lines.join("\n").includes('"event":"sms_capped"'));
  } finally {
    w.cap.restore();
  }
});

test("runner API failure or throw: stamps failed and nothing else changes", async () => {
  for (const opts of [
    { sendResult: { ok: false, reason: "http_5xx" as const } },
    { sendThrow: true },
  ]) {
    const w = makeWorld({ mode: "live", manager: MANAGER, ...opts });
    try {
      await w.toExhausted();
      assert.deepEqual(w.stamps.map((s) => s.status), ["failed"]);
      assert.equal(w.state().status, "exhausted", "ring outcome unchanged");
      assert.deepEqual(w.state().outcome_log.map((o) => o.outcome), ["declined"]);
      assert.ok(w.cap.lines.join("\n").includes('"event":"sms_failed"'));
    } finally {
      w.cap.restore();
    }
  }
});

test("runner: no MANAGER_PHONE skips cleanly with no_manager", async () => {
  const w = makeWorld({ mode: "live" }); // manager unset
  try {
    await w.toExhausted();
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.stamps.map((s) => s.status), ["skipped"]);
    const out = w.cap.lines.join("\n");
    assert.ok(out.includes('"event":"sms_skipped"') && out.includes("no_manager"));
  } finally {
    w.cap.restore();
  }
});

test("runner: a non-+61 manager number is not texted", async () => {
  const w = makeWorld({ mode: "live", manager: "15551234567" });
  try {
    await w.toExhausted();
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.stamps.map((s) => s.status), ["skipped"]);
    assert.ok(w.cap.lines.join("\n").includes("prefix"));
  } finally {
    w.cap.restore();
  }
});

test("runner idempotent: a second invocation for the same job sends nothing", async () => {
  const w = makeWorld({ mode: "live", manager: MANAGER });
  try {
    await w.toExhausted();
    assert.equal(w.sent.length, 1);
    assert.deepEqual(w.stamps.map((s) => s.status), ["sent"]);
    // A duplicate webhook drives a fresh machine back to exhaustion for this job.
    w.setRing(prompting(["t1"]));
    await runRing(w.deps, "call-C1", gather("2"));
    assert.equal(w.sent.length, 1, "no second text");
    assert.equal(w.stamps.length, 1, "the stamp is not written twice");
    assert.ok(w.cap.lines.join("\n").includes("already_done"));
  } finally {
    w.cap.restore();
  }
});

// --- ringstart (direct call on no_candidates) --------------------------------

function startEnv(mode: string, capOk: boolean): StartRingEnv {
  const directory = {
    flag: async (name: string) => (name === "ring_mode" ? mode : null),
    bumpCounter: async () => ({ ok: capOk, count: 1 }),
  };
  return { DIRECTORY: { idFromName: () => directory } };
}

test("ringstart: no_candidates texts the manager once; mode_off and capped do not", async () => {
  // A job with no trade any pool technician covers ends with no candidates.
  const w = makeWorld({ mode: "live", manager: MANAGER, job: { ...JOB, trade: "" } });
  try {
    const r = await startRing(startEnv("live", true), "call-C1", { depsFor: () => w.deps });
    assert.equal(r.reason, "no_candidates");
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].to, "+61400000099");
    assert.ok(w.sent[0].text.includes("JA4F7C") && w.sent[0].text.includes("UNASSIGNED"));
    assert.deepEqual(w.stamps.map((s) => s.status), ["sent"]);
  } finally {
    w.cap.restore();
  }

  const off = makeWorld({ mode: "live", manager: MANAGER });
  try {
    const r = await startRing(startEnv("off", true), "call-C1", { depsFor: () => off.deps });
    assert.equal(r.reason, "mode_off");
    assert.equal(off.sent.length, 0);
    assert.equal(off.stamps.length, 0);
  } finally {
    off.cap.restore();
  }

  const capped = makeWorld({ mode: "live", manager: MANAGER });
  try {
    const r = await startRing(startEnv("live", false), "call-C1", { depsFor: () => capped.deps });
    assert.equal(r.reason, "capped");
    assert.equal(capped.sent.length, 0);
    assert.equal(capped.stamps.length, 0);
  } finally {
    capped.cap.restore();
  }
});

// --- privacy + layout --------------------------------------------------------

test("privacy: no manager number, name or address in any log line", async () => {
  const w = makeWorld({ mode: "live", manager: MANAGER });
  try {
    await w.toExhausted();
    const out = w.cap.lines.join("\n");
    for (const pii of ["61400000099", "+61400000099", "0400000099", "Sam Chen", "Example St", "61412345678"]) {
      assert.ok(!out.includes(pii), `logs must not contain ${pii}`);
    }
  } finally {
    w.cap.restore();
  }
});

test("layout: hazards first and never cut, details cut at the cap, total at most 320", () => {
  const hazards = "live wires at the switchboard ".repeat(4).trim();
  const job: AcceptSmsJob = {
    ...JOB,
    customer_name: "Sam Chen \u{1F600}",
    hazards,
    details: "d".repeat(500),
  };
  const body = buildManagerSms(job);
  assert.ok(body.length <= SMS_MAX_LEN);
  const lines = body.split("\n");
  assert.ok(lines[0].includes("JA4F7C") && lines[0].endsWith("UNASSIGNED"));
  assert.equal(lines[1], "Nobody accepted. Emergency plumber");
  const hz = lines.find((l) => l.startsWith("HAZARD: "));
  assert.equal(hz, "HAZARD: " + hazards, "hazards never cut");
  assert.ok(lines.indexOf(hz!) < lines.findIndex((l) => l.startsWith("Customer:")), "hazards first");
  assert.ok(body.includes("Details: d") && !body.includes("d".repeat(100)), "details cut");
  assert.ok(body.endsWith("Do not reply."));
  assert.ok(lines.every((l) => !/[^\x20-\x7E]/.test(l)), "printable ASCII on every line");
});
