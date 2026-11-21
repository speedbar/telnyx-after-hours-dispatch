// tests/acceptsms.test.ts
// D20b-1: spoken brief without customer PII, one details SMS on accept.
// Fakes only, no network; the jobs stub applies the REAL reducer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../src/lib/brief.js";
import { buildAcceptSms, SMS_MAX_LEN, type AcceptSmsJob } from "../src/lib/sms.js";
import {
  initRingState,
  reduceRing,
  type DialResult,
  type RingEvent,
  type RingState,
} from "../src/lib/ring.js";
import { runRing, type RingJob, type RunRingDeps } from "../src/lib/ringrun.js";
import type { TelnyxClient } from "../src/lib/telnyx-api.js";
import type { TechPhones } from "../src/lib/techphones.js";

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

// --- reducer (pure) ----------------------------------------------------------

function prompting(): RingState {
  let s = reduceRing(initRingState(), start(["t1", "t2"]))[0];
  s = reduceRing(s, { type: "dial_result", ok: true, call_control_id: CC1, now: 2 })[0];
  s = reduceRing(s, answered())[0];
  return s;
}

test("reducer: accept produces sms_details exactly once, after confirm_hangup", () => {
  const [s, eff] = reduceRing(prompting(), gather("1"));
  assert.equal(s.status, "accepted");
  const sms = eff.filter((e) => e.type === "sms_details");
  assert.equal(sms.length, 1);
  assert.deepEqual(sms[0], { type: "sms_details", technician_id: "t1", attempt: 1 });
  const types = eff.map((e) => e.type);
  assert.ok(types.indexOf("confirm_hangup") < types.indexOf("sms_details"));
});

test("reducer: decline, no-answer and hangup produce no sms_details", () => {
  const [, dec] = reduceRing(prompting(), gather("2"));
  assert.ok(!dec.some((e) => e.type === "sms_details"));
  let s = reduceRing(initRingState(), start(["t1"]))[0];
  s = reduceRing(s, { type: "dial_result", ok: true, call_control_id: CC1, now: 2 })[0];
  const [, noans] = reduceRing(s, { type: "hangup", call_control_id: CC1, event_id: "e2", now: 3 });
  assert.ok(!noans.some((e) => e.type === "sms_details"));
  const [, hung] = reduceRing(prompting(), { type: "hangup", call_control_id: CC1, event_id: "e2", now: 3 });
  assert.ok(!hung.some((e) => e.type === "sms_details"));
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
  phones?: TechPhones;
} = {}) {
  const cap = captureLogs();
  let ring: RingState = initRingState();
  const sent: { to: string; text: string }[] = [];
  const stamps: { status: string; at: number }[] = [];
  const dispatches: unknown[] = [];
  const speaks: string[] = [];
  const jobs = {
    async ringEvent(event: RingEvent) {
      const [next, effects] = reduceRing(ring, event);
      ring = next;
      return { state: ring, effects };
    },
    async get() {
      return { ...JOB, ring };
    },
    async smsDone(args: { status: string; at: number }) {
      stamps.push(args);
      return { ok: true };
    },
  };
  const tech = (_id: string) => ({
    reserve: async () => ({ ok: true as const }),
    extendHold: async () => ({ extended: true }),
    release: async () => ({ released: true }),
    dispatch: async (args: unknown) => {
      dispatches.push(args);
      return { ok: true as const };
    },
  });
  const client: TelnyxClient = {
    async dial() {
      throw new Error("unneeded");
    },
    async gatherUsingSpeak() {
      return { ok: true };
    },
    async speak(_ccid, o) {
      speaks.push(o.payload);
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
    phones: opts.phones ?? { phones: { t1: "61400000001", t2: "61400000002" }, invalid: [] },
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
    },
  };
  return {
    deps,
    sent,
    stamps,
    dispatches,
    speaks,
    cap,
    state: () => ring,
    async toAccepted() {
      await runRing(deps, "call-C1", start(["t1", "t2"]));
      await runRing(deps, "call-C1", answered());
      await runRing(deps, "call-C1", gather("1"));
    },
  };
}

test("runner live: sends once to the technician, body has ref, name, callback, address", async () => {
  const w = makeWorld({ mode: "live" });
  try {
    await w.toAccepted();
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].to, "+61400000001");
    const body = w.sent[0].text;
    assert.ok(body.includes("JA4F7C") && body.includes("emergency plumber"));
    assert.ok(body.includes("Sam Chen"), "customer name texted");
    assert.ok(body.includes("Callback 0412345678"), "callback in local form");
    assert.ok(body.includes("12 Example St"), "address texted");
    assert.ok(body.endsWith("Do not reply."));
    assert.ok(body.length <= SMS_MAX_LEN);
    assert.deepEqual(w.stamps.map((s) => s.status), ["sent"]);
    assert.equal(w.state().status, "accepted");
    assert.equal(w.dispatches.length, 1);
    assert.equal(w.speaks.length, 1, "confirmation speech intact");
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
    const w = makeWorld({ mode });
    try {
      await w.toAccepted();
      assert.equal(w.sent.length, 0, mode);
      assert.deepEqual(w.stamps.map((s) => s.status), [status]);
      assert.ok(w.cap.lines.join("\n").includes(`"event":"${marker}"`));
      assert.equal(w.state().status, "accepted");
    } finally {
      w.cap.restore();
    }
  }
});

test("runner capped: daily cap hit skips the send", async () => {
  const w = makeWorld({ mode: "live", capOk: false });
  try {
    await w.toAccepted();
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.stamps.map((s) => s.status), ["capped"]);
    assert.ok(w.cap.lines.join("\n").includes('"event":"sms_capped"'));
  } finally {
    w.cap.restore();
  }
});

test("runner API failure or throw: accept intact, sms_status failed", async () => {
  for (const opts of [
    { sendResult: { ok: false, reason: "http_5xx" as const } },
    { sendThrow: true },
  ]) {
    const w = makeWorld({ mode: "live", ...opts });
    try {
      await w.toAccepted();
      assert.deepEqual(w.stamps.map((s) => s.status), ["failed"]);
      assert.equal(w.state().status, "accepted", "accept outcome unchanged");
      assert.equal(w.dispatches.length, 1, "dispatch marking unchanged");
      assert.equal(w.speaks.length, 1, "confirmation speech not blocked");
      assert.ok(w.cap.lines.join("\n").includes('"event":"sms_failed"'));
    } finally {
      w.cap.restore();
    }
  }
});

test("allow-list: non-+61 and premium technician numbers are never texted", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ t1: "15551234567" }, "prefix"], // US number
    [{ t1: "61190012345" }, "denied_pattern"], // AU 1900 premium
  ];
  for (const [phones, reason] of cases) {
    const w = makeWorld({ mode: "live", phones: { phones, invalid: [] } });
    try {
      await w.toAccepted();
      assert.equal(w.sent.length, 0, reason);
      assert.deepEqual(w.stamps.map((s) => s.status), ["failed"]);
      const out = w.cap.lines.join("\n");
      assert.ok(out.includes('"event":"sms_skipped"'));
      assert.ok(out.includes(reason));
    } finally {
      w.cap.restore();
    }
  }
});

test("privacy: no phone number, name or address in any log line", async () => {
  const w = makeWorld({ mode: "live" });
  try {
    await w.toAccepted();
    const out = w.cap.lines.join("\n");
    for (const pii of ["61400000001", "0412345678", "61412345678", "Sam Chen", "Example St", "Burst pipe"]) {
      assert.ok(!out.includes(pii), `logs must not contain ${pii}`);
    }
  } finally {
    w.cap.restore();
  }
});

test("template: 320-char cap, details truncated, emoji stripped, cap respected", () => {
  const job: AcceptSmsJob = {
    ...JOB,
    customer_name: "Sam Chen \u{1F600}\u{1F525}",
    details: "d".repeat(500),
  };
  const body = buildAcceptSms(job);
  assert.ok(body.length <= SMS_MAX_LEN);
  assert.ok(body.endsWith("Do not reply."));
  assert.ok(!/[^\x20-\x7E]/.test(body), "printable ASCII only");
  assert.ok(body.includes("Details: d"));
  const minimal = buildAcceptSms({
    job_id: "JA4F7C",
    urgency: "urgent",
    trade: "electrical",
    suburb: "Geelong",
  });
  assert.ok(!minimal.includes("Customer") && !minimal.includes("Callback") && !minimal.includes("Address"));
});

test("brief: address and reference spoken, never the name or callback digits", () => {
  const b = buildBrief({
    job_id: "JA4F7C",
    urgency: "emergency",
    trade: "plumber",
    suburb: "Richmond",
    address: "12 Example St",
  });
  assert.ok(b.includes("12 Example St"));
  assert.ok(b.includes("Reference J A 4 F 7 C"));
  assert.ok(b.includes("texted to you after you accept"));
  assert.ok(!b.includes("Sam Chen"), "no customer name");
  assert.ok(!b.includes("61412345678") && !b.includes("0412345678"), "no callback digits");
  assert.ok(!b.includes("0 4 1 2 3 4 5 6 7 8"), "no spoken callback");
});
