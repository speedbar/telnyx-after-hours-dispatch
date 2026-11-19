// tests/validate.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFloors,
  cleanText,
  isCallRef,
  isJobId,
  jobIdFromCallRef,
  normalisePhone,
  oneOf,
  resolveCallRef,
  spoken,
} from "../src/lib/validate.js";

test("normalisePhone normalises AU formats to digits", () => {
  for (const v of [
    "0412 000 001",
    "+61412000001",
    "61412000001",
    "0412-000-001",
  ]) {
    assert.equal(normalisePhone(v), "61412000001");
  }
  for (const v of ["12345", "abc", "1".repeat(25), "", 61, null]) {
    assert.equal(normalisePhone(v), null);
  }
});

test("cleanText strips control characters and collapses whitespace", () => {
  assert.equal(cleanText("a\u0007b\u007Fc", 10), "abc");
  assert.equal(cleanText("  a\n b\t c  ", 20), "a b c");
  assert.equal(cleanText("x".repeat(61), 60), null);
  assert.equal(cleanText("   ", 10), null);
  assert.equal(cleanText(42, 10), null);
  assert.equal(cleanText("ok", 2), "ok");
});

test("isCallRef and isJobId accept and reject", () => {
  assert.equal(isCallRef("call_123-ABC:="), true);
  assert.equal(isCallRef("has a space"), false);
  assert.equal(isCallRef("a".repeat(129)), false);
  assert.equal(isCallRef(""), false);
  assert.equal(isJobId("JA2B3C"), true);
  assert.equal(isJobId("ja2b3c"), false);
  assert.equal(isJobId("JA2B3"), false);
  assert.equal(isJobId("XA2B3C"), false);
});

test("oneOf matches only listed values", () => {
  const list = ["a", "b"] as const;
  assert.equal(oneOf("a", list), "a");
  assert.equal(oneOf("c", list), null);
  assert.equal(oneOf(1, list), null);
});

test("jobIdFromCallRef is deterministic and matches isJobId", async () => {
  const a = await jobIdFromCallRef("call-xyz");
  assert.equal(a, await jobIdFromCallRef("call-xyz"));
  assert.equal(isJobId(a), true);
  assert.notEqual(a, await jobIdFromCallRef("call-other"));
});

test("spoken spaces every character", () => {
  assert.equal(spoken("JA2B3C"), "J A 2 B 3 C");
});

// S1.8 item 2: severity and trade floors.
test("applyFloors: gas keyword raises urgency and corrects trade", () => {
  assert.deepEqual(applyFloors("plumbing", "urgent", "I can smell gas"), {
    trade: "gas",
    urgency: "emergency",
    raised: true,
    corrected: true,
  });
  // A gas trade is always an emergency, keyword or not.
  assert.deepEqual(applyFloors("gas", "urgent", "hot water pilot light out"), {
    trade: "gas",
    urgency: "emergency",
    raised: true,
    corrected: false,
  });
});

test("applyFloors: flooding raises urgency; a value is never lowered", () => {
  assert.deepEqual(applyFloors("plumbing", "urgent", "water is flooding the kitchen"), {
    trade: "plumbing",
    urgency: "emergency",
    raised: true,
    corrected: false,
  });
  // Already emergency with no keyword: unchanged, not lowered.
  assert.deepEqual(applyFloors("electrical", "emergency", "power point is dead"), {
    trade: "electrical",
    urgency: "emergency",
    raised: false,
    corrected: false,
  });
});

test("applyFloors: whole-word matching (gaslight does not match gas)", () => {
  assert.deepEqual(applyFloors("electrical", "urgent", "the gaslight fitting flickers"), {
    trade: "electrical",
    urgency: "urgent",
    raised: false,
    corrected: false,
  });
  assert.deepEqual(applyFloors("other", "urgent", "carbon monoxide alarm beeping"), {
    trade: "other",
    urgency: "emergency",
    raised: true,
    corrected: false,
  });
});

test("resolveCallRef: meta wins, SIP address becomes a c: ref, empties null, deterministic", async () => {
  const RE = /^c:[0-9a-f]{32}$/;
  // A SIP address or v3: string is accepted from args and hashed.
  const fromArgs = await resolveCallRef(
    { call_ref: "xxxx@sip.telnyx.com.au" },
    {},
  );
  assert.equal(fromArgs.source, "args");
  assert.match(fromArgs.ref as string, RE);
  // The _meta conversation id always wins over a model-sent value.
  const fromMeta = await resolveCallRef(
    { call_ref: "model-sent-value" },
    { meta_conversation_id: "conv-1" },
  );
  assert.equal(fromMeta.source, "meta");
  assert.match(fromMeta.ref as string, RE);
  assert.notEqual(fromMeta.ref, fromArgs.ref);
  // Empty meta falls back to args; same input gives the same ref.
  const emptyMeta = await resolveCallRef(
    { call_ref: "same-input" },
    { meta_conversation_id: "" },
  );
  assert.equal(emptyMeta.source, "args");
  assert.equal(
    emptyMeta.ref,
    (await resolveCallRef({ call_ref: "same-input" }, {})).ref,
  );
  // Nothing usable -> null.
  for (const [args, ctx] of [
    [{}, {}],
    [{ call_ref: "" }, {}],
    [{ call_ref: "x".repeat(201) }, {}],
    [{ call_ref: 42 }, {}],
    [null, {}],
  ] as const) {
    assert.deepEqual(await resolveCallRef(args, ctx), {
      ref: null,
      source: "none",
    });
  }
});
