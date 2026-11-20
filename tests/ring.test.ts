// tests/ring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initRingState,
  reduceRing,
  checkDialAllowed,
  parseAllowedPrefixes,
  withDialGate,
  SEEN_EVENTS_CAP,
  type DialResult,
  type RingEffect,
  type RingEvent,
  type RingOutcome,
  type RingState,
} from "../src/lib/ring.js";
import { toE164 } from "../src/lib/validate.js";

const types = (effects: RingEffect[]) => effects.map((e) => e.type);
const logEvents = (effects: RingEffect[]) =>
  effects.filter((e) => e.type === "log").map((e) => (e as { event: string }).event);

/** Drives mode=live start with two candidates through dial_result + answered, into prompting. */
function startPrompting(candidates: string[] = ["t1", "t2"]) {
  let state = initRingState();
  let r = reduceRing(state, { type: "start", mode: "live", candidates, now: 1000 });
  state = r[0];
  r = reduceRing(state, { type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  state = r[0];
  r = reduceRing(state, { type: "answered", call_control_id: "cc1", event_id: "e1", now: 1002 });
  return [r[0], r[1]] as const;
}

function startDialing(candidates: string[] = ["t1", "t2"]): RingState {
  let [s] = reduceRing(initRingState(), { type: "start", mode: "live", candidates, now: 1000 });
  [s] = reduceRing(s, { type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  return s;
}

test("start: idle -> dialing attempt 1 on the first candidate (already reserved)", () => {
  const [s, eff] = reduceRing(initRingState(), {
    type: "start",
    mode: "live",
    candidates: ["t1", "t2"],
    now: 1000,
  });
  assert.equal(s.status, "dialing");
  assert.equal(s.attempt, 1);
  assert.deepEqual(s.tried, ["t1"]);
  assert.deepEqual(s.current, { technician_id: "t1", call_control_id: "", started_at: 1000 });
  assert.deepEqual(types(eff), ["log", "extend_hold", "dial"]);
  assert.deepEqual(eff[2], { type: "dial", technician_id: "t1", attempt: 1 });
});

test("start: mode off -> disabled, never dials", () => {
  const [s, eff] = reduceRing(initRingState(), {
    type: "start",
    mode: "off",
    candidates: ["t1"],
    now: 0,
  });
  assert.equal(s.status, "disabled");
  assert.equal(types(eff).includes("dial"), false);
});

test("start: dry_run logs ring_dry_run for attempt 1 and ends terminal, never dials", () => {
  const [s, eff] = reduceRing(initRingState(), {
    type: "start",
    mode: "dry_run",
    candidates: ["t1", "t2"],
    now: 1000,
  });
  assert.ok(["accepted", "exhausted", "disabled"].includes(s.status), `terminal, got ${s.status}`);
  assert.equal(s.attempt, 0, "no attempt was made");
  assert.deepEqual(s.outcome_log, []);
  assert.deepEqual(eff, [{ type: "log", event: "ring_dry_run", technician_id: "t1", attempt: 1 }]);
  assert.ok(!types(eff).some((t) => t === "extend_hold" || t === "dial" || t === "reserve"));
});

test("start: no candidates -> exhausted + unassigned", () => {
  const [s, eff] = reduceRing(initRingState(), {
    type: "start",
    mode: "live",
    candidates: [],
    now: 0,
  });
  assert.equal(s.status, "exhausted");
  assert.ok(types(eff).includes("job_state"));
  assert.ok(logEvents(eff).includes("ring_exhausted"));
});

test("start: not idle is a no-op (one ring per job)", () => {
  const [s1] = startPrompting();
  const [s2, eff] = reduceRing(s1, { type: "start", mode: "live", candidates: ["t9"], now: 5000 });
  assert.equal(s2, s1);
  assert.deepEqual(eff, []);
});

test("happy path: answered -> press 1 -> accepted with dispatch effects", () => {
  const [s1, eff1] = startPrompting();
  assert.equal(s1.status, "prompting");
  assert.deepEqual(types(eff1), ["log", "gather_prompt"]);
  const [s2, eff2] = reduceRing(s1, {
    type: "gather",
    call_control_id: "cc1",
    digits: "1",
    event_id: "e2",
    now: 1003,
  });
  assert.equal(s2.status, "accepted");
  assert.deepEqual(s2.outcome_log, [{ technician_id: "t1", outcome: "accepted", at: 1003 }]);
  assert.deepEqual(types(eff2), ["log", "log", "log", "mark_dispatched", "job_state", "confirm_hangup"]);
  assert.ok(logEvents(eff2).includes("ring_gather"));
  assert.ok(logEvents(eff2).includes("ring_accepted"));
});

test("escalate: status reserving, only a reserve effect, no attempt increment", () => {
  const [s] = startPrompting();
  const [s1, eff1] = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1010 });
  assert.equal(s1.status, "reserving");
  assert.equal(s1.attempt, 1, "attempt not incremented before reserve_result");
  assert.deepEqual(s1.tried, ["t1"]);
  assert.equal(s1.current?.technician_id, "t2");
  assert.deepEqual(types(eff1), ["log", "log", "release", "hangup_call", "log", "reserve"]);
  assert.deepEqual(eff1[2], { type: "release", technician_id: "t1" });
  assert.deepEqual(eff1[5], { type: "reserve", technician_id: "t2" });
  assert.ok(logEvents(eff1).includes("ring_escalate"));
});

test("reserve_result ok: attempt increments, extend_hold + dial on the new tech", () => {
  const [s] = startPrompting();
  const [s1] = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1010 });
  const [s2, eff2] = reduceRing(s1, { type: "reserve_result", technician_id: "t2", ok: true, now: 1011 });
  assert.equal(s2.status, "dialing");
  assert.equal(s2.attempt, 2);
  assert.deepEqual(s2.tried, ["t1", "t2"]);
  assert.equal(s2.current?.started_at, 1011);
  assert.deepEqual(eff2, [
    { type: "extend_hold", technician_id: "t2" },
    { type: "dial", technician_id: "t2", attempt: 2 },
  ]);
});

test("reserve_result not ok: candidate skipped without using an attempt; can exhaust no_eligible", () => {
  const [s] = startPrompting(["t1", "t2", "t3"]);
  const [s1] = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1010 });
  const [s2, eff2] = reduceRing(s1, { type: "reserve_result", technician_id: "t2", ok: false, now: 1011 });
  assert.equal(s2.status, "reserving", "tried next candidate straight away");
  assert.equal(s2.attempt, 1, "no attempt consumed by a failed reserve");
  assert.equal(s2.current?.technician_id, "t3");
  assert.deepEqual(s2.tried, ["t1", "t2"]);
  assert.deepEqual(types(eff2), ["log", "reserve"]);
  assert.deepEqual(eff2[1], { type: "reserve", technician_id: "t3" });

  const [s3, eff3] = reduceRing(s2, { type: "reserve_result", technician_id: "t3", ok: false, now: 1012 });
  assert.equal(s3.status, "exhausted");
  assert.deepEqual(s3.tried, ["t1", "t2", "t3"]);
  const exh = eff3.find((e) => e.type === "log" && (e as { event?: string }).event === "ring_exhausted");
  assert.equal((exh as { reason?: string }).reason, "no_eligible");
  assert.ok(types(eff3).includes("job_state"));
});

test("stale reserve_result (wrong tech or wrong phase) is a no-op", () => {
  // wrong technician while reserving
  const [s] = startPrompting();
  const [s1] = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1010 });
  const [r1, re1] = reduceRing(s1, { type: "reserve_result", technician_id: "t9", ok: true, now: 1011 });
  assert.equal(r1, s1);
  assert.deepEqual(re1, []);
  // right technician but not in the reserving phase
  const [p1] = startPrompting();
  const [r2, re2] = reduceRing(p1, { type: "reserve_result", technician_id: "t1", ok: true, now: 1011 });
  assert.equal(r2, p1);
  assert.deepEqual(re2, []);
});

test("decline on attempt 2 (after a successful re-reserve) exhausts at max_attempts", () => {
  let s = startPrompting()[0];
  s = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1010 })[0];
  s = reduceRing(s, { type: "reserve_result", technician_id: "t2", ok: true, now: 1011 })[0];
  s = reduceRing(s, { type: "dial_result", ok: true, call_control_id: "cc2", now: 1012 })[0];
  s = reduceRing(s, { type: "answered", call_control_id: "cc2", event_id: "e3", now: 1013 })[0];
  const [s5, eff5] = reduceRing(s, { type: "gather", call_control_id: "cc2", digits: "2", event_id: "e4", now: 1014 });
  assert.equal(s5.status, "exhausted");
  assert.deepEqual(s5.outcome_log.map((o) => o.outcome), ["declined", "declined"]);
  assert.ok(logEvents(eff5).includes("ring_exhausted"));
  const exh = eff5.find((e) => e.type === "log" && (e as { event?: string }).event === "ring_exhausted");
  assert.equal((exh as { reason?: string }).reason, "max_attempts");
});

test("no_input (gather timeout) escalates; exhausts at attempt 2", () => {
  let s = startPrompting()[0];
  s = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "", event_id: "e2", now: 1010 })[0];
  assert.equal(s.outcome_log[0].outcome, "no_input");
  s = reduceRing(s, { type: "reserve_result", technician_id: "t2", ok: true, now: 1011 })[0];
  s = reduceRing(s, { type: "dial_result", ok: true, call_control_id: "cc2", now: 1012 })[0];
  s = reduceRing(s, { type: "answered", call_control_id: "cc2", event_id: "e3", now: 1013 })[0];
  const [s4, eff4] = reduceRing(s, { type: "gather", call_control_id: "cc2", digits: "", event_id: "e4", now: 1014 });
  assert.equal(s4.status, "exhausted");
  assert.deepEqual(s4.outcome_log.map((o) => o.outcome), ["no_input", "no_input"]);
  assert.ok(logEvents(eff4).includes("ring_exhausted"));
});

test("hangup_call is emitted only for declined and no_input", () => {
  const cases: Array<[RingOutcome, () => RingState, RingEvent]> = [
    ["declined", () => startPrompting()[0], { type: "gather", call_control_id: "cc1", digits: "2", event_id: "g1", now: 1010 }],
    ["no_input", () => startPrompting()[0], { type: "gather", call_control_id: "cc1", digits: "", event_id: "g2", now: 1010 }],
    ["no_answer", () => startDialing(), { type: "hangup", call_control_id: "cc1", event_id: "h1", now: 1010 }],
    ["hung_up", () => startPrompting()[0], { type: "hangup", call_control_id: "cc1", event_id: "h2", now: 1010 }],
    ["dial_failed", () => startDialing(), { type: "dial_result", ok: false, now: 1010 }],
  ];
  for (const [outcome, setup, ev] of cases) {
    const [s, eff] = reduceRing(setup(), ev);
    assert.equal(s.outcome_log[0].outcome, outcome, outcome);
    const expectHangup = outcome === "declined" || outcome === "no_input";
    assert.equal(types(eff).includes("hangup_call"), expectHangup, `hangup_call for ${outcome}`);
  }
});

test("hangup before answer = no_answer, escalates into reserving", () => {
  const [s] = reduceRing(startDialing(), { type: "hangup", call_control_id: "cc1", event_id: "h1", now: 1005 });
  assert.equal(s.outcome_log[0].outcome, "no_answer");
  assert.equal(s.status, "reserving");
  assert.equal(s.attempt, 1);
  assert.equal(s.current?.technician_id, "t2");
});

test("hangup while prompting = hung_up", () => {
  const [s] = startPrompting();
  const [s1] = reduceRing(s, { type: "hangup", call_control_id: "cc1", event_id: "h2", now: 1010 });
  assert.equal(s1.outcome_log[0].outcome, "hung_up");
  assert.equal(s1.status, "reserving");
});

test("dial_failed at both attempts exhausts", () => {
  let [s] = reduceRing(initRingState(), { type: "start", mode: "live", candidates: ["t1", "t2"], now: 1000 });
  const [s1, eff1] = reduceRing(s, { type: "dial_result", ok: false, now: 1001 });
  assert.equal(s1.outcome_log[0].outcome, "dial_failed");
  assert.equal(s1.status, "reserving");
  assert.equal(s1.attempt, 1, "second dial not attempted yet");
  assert.ok(logEvents(eff1).includes("ring_dial_fail"));
  const [s2] = reduceRing(s1, { type: "reserve_result", technician_id: "t2", ok: true, now: 1002 });
  const [s3, eff3] = reduceRing(s2, { type: "dial_result", ok: false, now: 1003 });
  assert.equal(s3.status, "exhausted");
  assert.deepEqual(s3.outcome_log.map((o) => o.outcome), ["dial_failed", "dial_failed"]);
  assert.ok(logEvents(eff3).includes("ring_exhausted"));
});

test("decline with no remaining candidate exhausts (no_eligible)", () => {
  const [s] = startPrompting(["t1"]);
  const [s1, eff] = reduceRing(s, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e2", now: 1010 });
  assert.equal(s1.status, "exhausted");
  assert.ok(logEvents(eff).includes("ring_exhausted"));
  const exh = eff.find((e) => e.type === "log" && (e as { event?: string }).event === "ring_exhausted");
  assert.equal((exh as { reason?: string }).reason, "no_eligible");
});

test("duplicate event id is a no-op with ring_dup_event", () => {
  const [s1] = startPrompting();
  const [s2, eff2] = reduceRing(s1, { type: "answered", call_control_id: "cc1", event_id: "e1", now: 2000 });
  assert.equal(s2, s1); // state object untouched
  assert.deepEqual(eff2, [{ type: "log", event: "ring_dup_event" }]);
});

test("stale call_control_id is ignored with ring_stale_event", () => {
  const [s1] = startPrompting();
  const [s2, eff2] = reduceRing(s1, { type: "gather", call_control_id: "cc-old", digits: "1", event_id: "e9", now: 2000 });
  assert.equal(s2.status, "prompting"); // unchanged, no accept
  assert.deepEqual(s2.outcome_log, []);
  assert.deepEqual(eff2, [{ type: "log", event: "ring_stale_event", technician_id: "t1" }]);
});

test("gather after a decision is ignored (terminal protection)", () => {
  const [s1] = startPrompting();
  const [s2] = reduceRing(s1, { type: "gather", call_control_id: "cc1", digits: "1", event_id: "e2", now: 1003 });
  const [s3, eff3] = reduceRing(s2, { type: "gather", call_control_id: "cc1", digits: "2", event_id: "e5", now: 1004 });
  assert.equal(s3.status, "accepted");
  assert.equal(s3.outcome_log.length, 1);
  assert.deepEqual(eff3, []);
  const [s4, eff4] = reduceRing(s2, { type: "hangup", call_control_id: "cc1", event_id: "e6", now: 1005 });
  assert.equal(s4.status, "accepted");
  assert.deepEqual(eff4, []);
});

test("seen_event_ids is capped", () => {
  let s = initRingState();
  [s] = reduceRing(s, { type: "start", mode: "live", candidates: ["t1"], now: 1000 });
  [s] = reduceRing(s, { type: "dial_result", ok: true, call_control_id: "cc1", now: 1001 });
  for (let i = 0; i < SEEN_EVENTS_CAP + 5; i++) {
    [s] = reduceRing(s, { type: "answered", call_control_id: "cc1", event_id: `ev-${i}`, now: 1002 + i });
  }
  assert.equal(s.seen_event_ids.length, SEEN_EVENTS_CAP);
  assert.equal(s.seen_event_ids[s.seen_event_ids.length - 1], `ev-${SEEN_EVENTS_CAP + 4}`);
});

// --- dial gate -------------------------------------------------------------

test("toE164 adds the plus to normalised digits", () => {
  assert.equal(toE164("61412345678"), "+61412345678");
});

test("checkDialAllowed: +61 allowed, other prefixes and premium/short numbers denied", () => {
  assert.deepEqual(checkDialAllowed("+61412345678"), { allowed: true });
  assert.deepEqual(checkDialAllowed("+14155550100"), { allowed: false, reason: "prefix" });
  for (const n of ["+611900123456", "+611300123456", "+611800123456", "+61000", "+61112", "+61106"]) {
    assert.deepEqual(checkDialAllowed(n), { allowed: false, reason: "denied_pattern" }, n);
  }
  // a 0413 mobile must not trip the "13" deny pattern
  assert.deepEqual(checkDialAllowed("+61413123456"), { allowed: true });
});

test("parseAllowedPrefixes: csv or the +61 default", () => {
  assert.deepEqual(parseAllowedPrefixes(undefined), ["+61"]);
  assert.deepEqual(parseAllowedPrefixes(""), ["+61"]);
  assert.deepEqual(parseAllowedPrefixes(" +61, +64 "), ["+61", "+64"]);
});

test("withDialGate: denied numbers never reach the dialer; errors are data", async () => {
  const calls: string[] = [];
  const inner = async (to: string): Promise<DialResult> => {
    calls.push(to);
    return { ok: true, call_control_id: "cc" };
  };
  const dial = withDialGate(undefined, inner);
  assert.deepEqual(await dial("61412345678"), { ok: true, call_control_id: "cc" });
  assert.deepEqual(calls, ["61412345678"]);
  assert.deepEqual(await dial("611900123456"), { ok: false, reason: "denied_pattern" });
  assert.deepEqual(await dial("14155550100"), { ok: false, reason: "prefix" });
  assert.deepEqual(calls, ["61412345678"], "denied calls never reach the dialer");

  const throwing = withDialGate(undefined, () => Promise.reject(new Error("boom")));
  assert.deepEqual(await throwing("61412345678"), { ok: false, reason: "dialer_error" });
});
