// tests/voice.test.ts
// D20-4b /voice-events route tests. Signing helpers and the keypair pattern
// are copied from tests/dv.test.ts. Fakes only: no network, no real actors —
// the fake jobs stub applies the REAL reducer so dedupe behaviour is genuine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleVoiceEvents, type VoiceEnv } from "../src/routes/voice.js";
import { encodeClientState, type TelnyxClient } from "../src/lib/telnyx-api.js";
import {
  initRingState,
  reduceRing,
  type RingEffect,
  type RingEvent,
  type RingState,
} from "../src/lib/ring.js";
import type { RingJob, RunRingDeps } from "../src/lib/ringrun.js";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const CC1 = "cc-test-0001";
const CALL_ACTOR = "call-C1";
const STATE = encodeClientState({ c: CALL_ACTOR, j: "JA4F7C", t: "t1", a: 1 });

async function makeKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKeyB64: string;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKeyB64: Buffer.from(rawPub).toString("base64"),
  };
}

async function sign(
  privateKey: CryptoKey,
  timestamp: string,
  body: string,
): Promise<string> {
  const msg = new TextEncoder().encode(`${timestamp}|${body}`);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, msg);
  return Buffer.from(sig).toString("base64");
}

const fixture = makeKeyPair();

function makeBody(
  eventType: string,
  payload: Record<string, unknown> = {},
  id = "evt-1",
): string {
  return JSON.stringify({
    data: {
      event_type: eventType,
      id,
      occurred_at: "2026-11-21T00:00:00.000Z",
      payload: { call_control_id: CC1, client_state: STATE, ...payload },
    },
    meta: { attempt: 1 },
  });
}

function signedRequest(body: string, sig: string, timestamp: string): Request {
  return new Request("https://test.invalid/voice-events", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": sig,
      "telnyx-timestamp": timestamp,
    },
  });
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: unknown) => {
    lines.push(String(msg));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeEnv(publicKeyB64: string): VoiceEnv {
  return { TELNYX_PUBLIC_KEY: publicKeyB64 };
}

// --- fake ring deps -----------------------------------------------------------

const JOB: RingJob = {
  job_id: "JA4F7C",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Richmond",
  summary: "Burst pipe in the kitchen",
};

function makeWorld(ring0: RingState) {
  let ring = ring0;
  const ringEvents: RingEvent[] = [];
  const effectBatches: RingEffect[][] = [];
  const gathers: string[] = [];
  const speaks: string[] = [];
  const hangups: string[] = [];
  let dispatches = 0;
  const client: TelnyxClient = {
    dial: () => Promise.reject(new Error("route tests never dial")),
    gatherUsingSpeak: (ccid) => {
      gathers.push(ccid);
      return Promise.resolve({ ok: true });
    },
    speak: (ccid) => {
      speaks.push(ccid);
      return Promise.resolve({ ok: true });
    },
    hangup: (ccid) => {
      hangups.push(ccid);
      return Promise.resolve({ ok: true });
    },
  };
  const deps: RunRingDeps = {
    jobs: {
      async ringEvent(ev) {
        ringEvents.push(ev);
        const [next, effects] = reduceRing(ring, ev);
        ring = next;
        effectBatches.push(effects);
        return { state: ring, effects };
      },
      async get() {
        return { ...JOB, ring };
      },
    },
    tech: () => ({
      reserve: () => Promise.resolve({ ok: true }),
      extendHold: () => Promise.resolve({ extended: true }),
      release: () => Promise.resolve({ released: true }),
      dispatch: () => {
        dispatches += 1;
        return Promise.resolve({ ok: true });
      },
    }),
    client,
    dialer: () => Promise.resolve({ ok: false, reason: "not_dialed_here" }),
    phones: { phones: {}, invalid: [] },
    voice: "Telnyx.KokoroTTS.af",
    language: "en-US",
    holdTtlS: 60,
    busyS: 1800,
  };
  return {
    deps,
    ringEvents,
    effectBatches,
    gathers,
    speaks,
    hangups,
    dispatches: () => dispatches,
    state: () => ring,
  };
}

function ringingState(status: "dialing" | "prompting" | "accepted"): RingState {
  return {
    ...initRingState(),
    mode: "live",
    status,
    attempt: 1,
    tried: ["t1"],
    current: { technician_id: "t1", call_control_id: CC1, started_at: 1 },
    candidates: ["t1"],
  };
}

// Post one signed body to the route against a fresh world.
async function post(
  world: ReturnType<typeof makeWorld>,
  body: string,
  opts: { ts?: string; privateKey?: CryptoKey } = {},
): Promise<Response> {
  const { privateKey, publicKeyB64 } = await fixture;
  const ts = opts.ts ?? String(NOW_S);
  const sig = await sign(opts.privateKey ?? privateKey, ts, body);
  return handleVoiceEvents(
    signedRequest(body, sig, ts),
    makeEnv(publicKeyB64),
    NOW_MS,
    () => world.deps,
  );
}

// --- tests --------------------------------------------------------------------

test("1. missing TELNYX_PUBLIC_KEY: 403 forbidden, voice_sig_fail no_public_key, no runner", async () => {
  const had = Object.prototype.hasOwnProperty.call(
    process.env,
    "TELNYX_PUBLIC_KEY",
  );
  const previous = process.env.TELNYX_PUBLIC_KEY;
  delete process.env.TELNYX_PUBLIC_KEY;
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const req = new Request("https://test.invalid/voice-events", {
      method: "POST",
      body: makeBody("call.answered"),
    });
    const res = await handleVoiceEvents(req, {}, NOW_MS, () => world.deps);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    const fail = parsed(cap.lines).find((l) => l.event === "voice_sig_fail");
    assert.ok(fail, "expected a voice_sig_fail log line");
    assert.equal(fail.error, "no_public_key");
    assert.equal(fail.outcome, "rejected");
    assert.equal(world.ringEvents.length, 0);
  } finally {
    cap.restore();
    if (had) {
      process.env.TELNYX_PUBLIC_KEY = previous;
    }
  }
});

test("2. missing signature headers: 403 voice_sig_fail missing_headers, no runner", async () => {
  const { publicKeyB64 } = await fixture;
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const req = new Request("https://test.invalid/voice-events", {
      method: "POST",
      body: makeBody("call.answered"),
    });
    const res = await handleVoiceEvents(req, makeEnv(publicKeyB64), NOW_MS, () => world.deps);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    const fail = parsed(cap.lines).find((l) => l.event === "voice_sig_fail");
    assert.equal(fail?.error, "missing_headers");
    assert.equal(world.ringEvents.length, 0);
  } finally {
    cap.restore();
  }
});

test("3. stale timestamp and tampered body: both 403, no runner", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const world = makeWorld(ringingState("dialing"));
  const body = makeBody("call.answered");
  const cap = captureLog();
  try {
    // Stale: timestamp 600 s old, signed for that timestamp.
    const staleTs = String(NOW_S - 600);
    const staleSig = await sign(privateKey, staleTs, body);
    const resStale = await handleVoiceEvents(
      signedRequest(body, staleSig, staleTs),
      makeEnv(publicKeyB64),
      NOW_MS,
      () => world.deps,
    );
    assert.equal(resStale.status, 403);
    assert.deepEqual(await resStale.json(), { ok: false, error: "forbidden" });

    // Tampered: sign the real body, then change one character.
    const ts = String(NOW_S);
    const sig = await sign(privateKey, ts, body);
    const tampered = body.slice(0, -1) + "x";
    const resTampered = await handleVoiceEvents(
      signedRequest(tampered, sig, ts),
      makeEnv(publicKeyB64),
      NOW_MS,
      () => world.deps,
    );
    assert.equal(resTampered.status, 403);
    assert.deepEqual(await resTampered.json(), { ok: false, error: "forbidden" });

    const reasons = parsed(cap.lines)
      .filter((l) => l.event === "voice_sig_fail")
      .map((l) => l.error);
    assert.deepEqual(reasons, ["stale_timestamp", "bad_signature"]);
    assert.equal(world.ringEvents.length, 0);
  } finally {
    cap.restore();
  }
});

test("4. GET request: 405 method_not_allowed, no runner", async () => {
  const { publicKeyB64 } = await fixture;
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const req = new Request("https://test.invalid/voice-events", { method: "GET" });
    const res = await handleVoiceEvents(req, makeEnv(publicKeyB64), NOW_MS, () => world.deps);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, error: "method_not_allowed" });
    assert.equal(world.ringEvents.length, 0);
  } finally {
    cap.restore();
  }
});

test("5. valid signature but body is not JSON: 400 bad_json, no runner", async () => {
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const res = await post(world, "this is not json");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "bad_json" });
    assert.equal(world.ringEvents.length, 0);
  } finally {
    cap.restore();
  }
});

test("6. call.answered is mapped to an answered ring event and prompts the leg", async () => {
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const res = await post(world, makeBody("call.answered", {}, "evt-a1"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(world.ringEvents, [
      { type: "answered", call_control_id: CC1, event_id: "evt-a1", now: NOW_MS },
    ]);
    // The reducer's gather_prompt effect ran against the leg.
    assert.deepEqual(world.gathers, [CC1]);
    assert.equal(world.state().status, "prompting");
    const ve = parsed(cap.lines).find((l) => l.event === "voice_event");
    assert.ok(ve, "expected a voice_event log line");
    assert.equal(ve.node, "call.answered");
    assert.equal(ve.call_ref, CALL_ACTOR);
    assert.equal(ve.job_id, "JA4F7C");
    assert.equal(ve.technician_id, "t1");
    assert.equal(ve.attempt, 1);
    assert.match(String(ve.meta_keys), /call_control_id/);
    assert.ok(String(ve.meta_keys).length <= 200);
  } finally {
    cap.restore();
  }
});

test("7. call.gather.ended is mapped with digits 1, 2 and absent -> ''", async () => {
  for (const [digits, expected] of [["1", "1"], ["2", "2"], [undefined, ""]] as const) {
    const world = makeWorld(ringingState("prompting"));
    const cap = captureLog();
    try {
      const payload: Record<string, unknown> = {};
      if (digits !== undefined) payload.digits = digits;
      const res = await post(world, makeBody("call.gather.ended", payload, "evt-g1"));
      assert.equal(res.status, 200);
      await res.body?.cancel();
      assert.equal(world.ringEvents.length, 1);
      const ev = world.ringEvents[0];
      assert.equal(ev.type, "gather");
      if (ev.type === "gather") assert.equal(ev.digits, expected);
      const ve = parsed(cap.lines).find((l) => l.event === "voice_event");
      assert.equal(ve?.node, "call.gather.ended");
      assert.equal(ve?.digits ?? "", expected);
    } finally {
      cap.restore();
    }
  }
});

test("8. digits '1' accepts and dispatches the technician exactly once", async () => {
  const world = makeWorld(ringingState("prompting"));
  const cap = captureLog();
  try {
    const res = await post(world, makeBody("call.gather.ended", { digits: "1" }, "evt-g1"));
    assert.equal(res.status, 200);
    await res.body?.cancel();
    assert.equal(world.state().status, "accepted");
    assert.equal(world.dispatches(), 1);
    assert.deepEqual(world.speaks, [CC1], "confirmation spoken on the leg");
    assert.equal(world.hangups.length, 0, "accept never hangs up via the reducer");
  } finally {
    cap.restore();
  }
});

test("9. call.hangup is mapped and logs the enum-like hangup fields only", async () => {
  const world = makeWorld(ringingState("prompting"));
  const cap = captureLog();
  try {
    const res = await post(
      world,
      makeBody(
        "call.hangup",
        { hangup_cause: "normal_clearing", hangup_source: "callee" },
        "evt-h1",
      ),
    );
    assert.equal(res.status, 200);
    await res.body?.cancel();
    assert.deepEqual(world.ringEvents, [
      { type: "hangup", call_control_id: CC1, event_id: "evt-h1", now: NOW_MS },
    ]);
    const ve = parsed(cap.lines).find((l) => l.event === "voice_event");
    assert.equal(ve?.node, "call.hangup");
    assert.equal(ve?.hangup_cause, "normal_clearing");
    assert.equal(ve?.hangup_source, "callee");
  } finally {
    cap.restore();
  }
});

test("10. invalid client_state: 200, voice_event_no_state, no runner", async () => {
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const body = makeBody("call.answered", { client_state: "!!!not-base64!!!" }, "evt-n1");
    const res = await post(world, body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(world.ringEvents.length, 0);
    const noState = parsed(cap.lines).find((l) => l.event === "voice_event_no_state");
    assert.ok(noState, "expected a voice_event_no_state log line");
    assert.equal(noState.node, "call.answered");
  } finally {
    cap.restore();
  }
});

test("11. unknown event type: 200, voice_event_ignored with the type, no runner", async () => {
  const world = makeWorld(ringingState("prompting"));
  const cap = captureLog();
  try {
    const res = await post(world, makeBody("call.dtmf.received", { digit: "1" }, "evt-x1"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(world.ringEvents.length, 0);
    const ignored = parsed(cap.lines).find((l) => l.event === "voice_event_ignored");
    assert.ok(ignored, "expected a voice_event_ignored log line");
    assert.equal(ignored.node, "call.dtmf.received");
    // Ignored events never emit the payload-shape line.
    assert.ok(!parsed(cap.lines).some((l) => l.event === "voice_event"));
  } finally {
    cap.restore();
  }
});

test("12. call.speak.ended hangs up the leg only after a confirmation (accept or decline)", async () => {
  const cap = captureLog();
  try {
    const accepted = makeWorld(ringingState("accepted"));
    const resA = await post(accepted, makeBody("call.speak.ended", {}, "evt-s1"));
    assert.equal(resA.status, 200);
    await resA.body?.cancel();
    assert.deepEqual(accepted.hangups, [CC1]);
    assert.equal(accepted.ringEvents.length, 0, "speak.ended is not a reducer event");

    // D20b-2: a declined leg, stamped in confirm_ccid, hangs up the same way.
    const declined = makeWorld({ ...ringingState("dialing"), confirm_ccid: CC1 });
    const resD = await post(declined, makeBody("call.speak.ended", {}, "evt-s3"));
    assert.equal(resD.status, 200);
    await resD.body?.cancel();
    assert.deepEqual(declined.hangups, [CC1]);

    const prompting = makeWorld(ringingState("prompting"));
    const resB = await post(prompting, makeBody("call.speak.ended", {}, "evt-s2"));
    assert.equal(resB.status, 200);
    await resB.body?.cancel();
    assert.equal(prompting.hangups.length, 0);
    assert.equal(prompting.ringEvents.length, 0);
  } finally {
    cap.restore();
  }
});

test("13. duplicate delivery of the same event id is harmless (reducer dedupe)", async () => {
  const world = makeWorld(ringingState("prompting"));
  const cap = captureLog();
  try {
    const body = makeBody("call.gather.ended", { digits: "1" }, "evt-dup");
    const first = await post(world, body);
    assert.equal(first.status, 200);
    await first.body?.cancel();
    const second = await post(world, body);
    assert.equal(second.status, 200);
    await second.body?.cancel();
    assert.equal(world.ringEvents.length, 2, "both deliveries reach the reducer");
    const dup = world.effectBatches[1];
    assert.deepEqual(dup, [{ type: "log", event: "ring_dup_event" }]);
    assert.equal(world.dispatches(), 1, "the technician is dispatched once");
    assert.equal(world.speaks.length, 1, "the confirmation is spoken once");
    assert.equal(world.state().status, "accepted");
  } finally {
    cap.restore();
  }
});

test("14. privacy: logs carry no phone numbers, no client_state and no body", async () => {
  const world = makeWorld(ringingState("dialing"));
  const cap = captureLog();
  try {
    const body = makeBody(
      "call.answered",
      {
        from: "+61400000000",
        to: "+61411111111",
        marker_field: "MARKERVALUE123",
      },
      "evt-p1",
    );
    const res = await post(world, body);
    assert.equal(res.status, 200);
    await res.body?.cancel();
    const joined = cap.lines.join("\n");
    assert.ok(!joined.includes("61400000000"), "no from digits logged");
    assert.ok(!joined.includes("61411111111"), "no to digits logged");
    assert.ok(!joined.includes(STATE), "client_state is never logged");
    assert.ok(!joined.includes("MARKERVALUE123"), "no payload value is logged");
    assert.ok(!joined.includes(CC1), "the call_control_id value is never logged");
    assert.ok(!joined.includes(body), "the raw body is never logged");
    // Key NAMES are learned (this is the payload-shape diagnostic).
    const ve = parsed(cap.lines).find((l) => l.event === "voice_event");
    assert.match(String(ve?.meta_keys), /marker_field/);
  } finally {
    cap.restore();
  }
});
