// tests/ringwording.test.ts
// D20b-2: natural spoken wording (brief + accept/decline confirmations) and
// the RING_VOICE switch. Fakes only, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../src/lib/brief.js";
import { initRingState, reduceRing, type RingEvent } from "../src/lib/ring.js";
import { runRing, type RingJob, type RunRingDeps } from "../src/lib/ringrun.js";
import { makeTelnyxClient } from "../src/lib/telnyx-api.js";
import { buildRingDeps } from "../src/routes/voice.js";

const FULL = {
  job_id: "JA4F7C",
  urgency: "emergency",
  trade: "plumbing",
  suburb: "Footscray",
  address: "12 Example Street",
};

test("brief: suburb, house number as a normal number, the press-1 line only", () => {
  const b = buildBrief(FULL);
  assert.equal(
    b,
    "Hi, Harbour Trades After-Hours dispatch. Emergency plumbing job in Footscray, " +
      "12 Example Street. Press 1 to accept, or 2 to decline.",
  );
  assert.ok(b.includes("Footscray"), "suburb spoken");
  assert.ok(b.includes("12 Example Street"), "house number as a normal number");
  assert.ok(b.includes("Press 1 to accept, or 2 to decline"));
  assert.ok(!/\b\d(?: \d)+\b/.test(b), "no spaced single digits");
  assert.ok(!b.includes("Reference") && !b.includes("JA4F7C"), "no reference");
  assert.ok(!b.includes("61412345678") && !/\b\d{6,}\b/.test(b), "no callback digit run");
  assert.ok(!/text|sms/i.test(b), "no mention of the text message");
});

test("brief: missing suburb / address / trade drop their fragment cleanly", () => {
  assert.equal(
    buildBrief({ ...FULL, suburb: "" }),
    "Hi, Harbour Trades After-Hours dispatch. Emergency plumbing job 12 Example Street. " +
      "Press 1 to accept, or 2 to decline.",
  );
  assert.equal(
    buildBrief({ job_id: FULL.job_id, urgency: "emergency", trade: "plumbing", suburb: "Footscray" }),
    "Hi, Harbour Trades After-Hours dispatch. Emergency plumbing job in Footscray. " +
      "Press 1 to accept, or 2 to decline.",
  );
  assert.equal(
    buildBrief({ ...FULL, trade: "" }),
    "Hi, Harbour Trades After-Hours dispatch. Emergency job in Footscray, 12 Example Street. " +
      "Press 1 to accept, or 2 to decline.",
  );
  for (const b of [
    buildBrief({ ...FULL, suburb: "" }),
    buildBrief({ ...FULL, trade: "" }),
    buildBrief({ ...FULL, urgency: "" }),
  ]) {
    assert.ok(!b.includes("undefined") && !b.includes(",,") && !b.includes(" ,"), b);
  }
});

// --- confirmations through the runner ---------------------------------------

const CC1 = "cc-61400000001";
const JOB: RingJob = {
  job_id: "JA4F7C",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Richmond",
  summary: "Burst pipe",
  address: "12 Example St",
};

function makeWorld() {
  let ring = initRingState();
  const speaks: { ccid: string; payload: string; voice?: string }[] = [];
  const hangups: string[] = [];
  const deps: RunRingDeps = {
    jobs: {
      async ringEvent(ev: RingEvent) {
        const [next, effects] = reduceRing(ring, ev);
        ring = next;
        return { state: ring, effects };
      },
      async get() {
        return { ...JOB, ring };
      },
    },
    tech: () => ({
      reserve: async () => ({ ok: true }),
      extendHold: async () => ({ extended: true }),
      release: async () => ({ released: true }),
      dispatch: async () => ({ ok: true }),
    }),
    client: {
      dial: () => Promise.reject(new Error("unused in wording tests")),
      gatherUsingSpeak: () => Promise.resolve({ ok: true }),
      speak: (ccid, o) => {
        speaks.push({ ccid, payload: o.payload, ...(o.voice !== undefined ? { voice: o.voice } : {}) });
        return Promise.resolve({ ok: true });
      },
      hangup: (ccid) => {
        hangups.push(ccid);
        return Promise.resolve({ ok: true });
      },
    },
    dialer: async () => ({ ok: true, call_control_id: CC1 }),
    phones: { phones: { t1: "61400000001" }, invalid: [] },
    language: "en-AU",
    holdTtlS: 60,
    busyS: 1800,
  };
  return { deps, speaks, hangups, state: () => ring };
}

async function toPrompting(w: ReturnType<typeof makeWorld>) {
  await runRing(w.deps, "call-C1", { type: "start", mode: "live", candidates: ["t1"], now: 1 });
  await runRing(w.deps, "call-C1", { type: "answered", call_control_id: CC1, event_id: "e1", now: 2 });
}

function silenceLogs(): () => void {
  const orig = console.log;
  console.log = () => {};
  return () => {
    console.log = orig;
  };
}

test("accept confirmation: exact text, no voice field when RING_VOICE unset", async () => {
  const w = makeWorld();
  const restore = silenceLogs();
  try {
    await toPrompting(w);
    await runRing(w.deps, "call-C1", { type: "gather", call_control_id: CC1, digits: "1", event_id: "e2", now: 3 });
    assert.deepEqual(
      w.speaks.map((s) => s.payload),
      ["Thank you. The customer details will be sent to you by text message. Goodbye."],
    );
    assert.ok(w.speaks.every((s) => !("voice" in s)), "no voice field passed when RING_VOICE unset");
  } finally {
    restore();
  }
});

test("decline confirmation: exact text, hangup deferred to speak.ended", async () => {
  const w = makeWorld();
  const restore = silenceLogs();
  try {
    await toPrompting(w);
    await runRing(w.deps, "call-C1", { type: "gather", call_control_id: CC1, digits: "2", event_id: "e2", now: 3 });
    assert.deepEqual(w.speaks.map((s) => s.payload), ["No problem, thank you. Goodbye."]);
    assert.deepEqual(w.hangups, [], "no immediate hangup on decline");
    assert.equal(w.state().confirm_ccid, CC1);
  } finally {
    restore();
  }
});

// --- RING_VOICE ---------------------------------------------------------------

test("RING_VOICE unset: speak body byte-identical with no voice key; set: voice sent", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = makeTelnyxClient({ TELNYX_API_KEY: "test-key" }, fetchImpl);

  await client.speak("ccid_1", { payload: "p", language: "en-US" });
  assert.deepEqual(bodies[0], { payload: "p", language: "en-US" });
  assert.ok(!("voice" in bodies[0]));

  await client.speak("ccid_1", { payload: "p", language: "en-US", voice: "v9" });
  assert.deepEqual(bodies[1], { payload: "p", language: "en-US", voice: "v9" });

  // env wiring into the runner deps (empty string counts as unset)
  assert.equal(buildRingDeps({}, "call-x").voice, undefined);
  assert.equal(buildRingDeps({ RING_VOICE: "" }, "call-x").voice, undefined);
  assert.equal(buildRingDeps({ RING_VOICE: "v9" }, "call-x").voice, "v9");
});
