// tests/validate.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  isCallRef,
  isJobId,
  jobIdFromCallRef,
  normalisePhone,
  oneOf,
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
