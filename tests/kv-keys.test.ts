// tests/kv-keys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEY_PATTERN,
  sanitizeSegment,
  assertValidKey,
  keys,
} from "../src/lib/kv-keys.js";

test("keys.flag builds a flag key", () => {
  assert.equal(keys.flag("dispatch_enabled"), "flag/dispatch_enabled");
});

test("keys.customer strips the leading plus", () => {
  assert.equal(keys.customer("+61412345678"), "cust/61412345678");
});

test("keys.job builds a job key", () => {
  assert.equal(keys.job("JA47"), "job/JA47");
});

test("keys.jobByCall replaces colon with underscore", () => {
  assert.equal(keys.jobByCall("v3:abc-123"), "job-by-call/v3_abc-123");
});

test("sanitizeSegment replaces slash, space and plus", () => {
  // a "/" inside a segment must never create a new path level
  assert.equal(sanitizeSegment("a/b c+d"), "a_b_c_d");
});

test("sanitizeSegment throws on empty result", () => {
  assert.throws(() => sanitizeSegment(""), /invalid_kv_segment/);
});

test("assertValidKey rejects a colon, accepts a slash", () => {
  assert.throws(() => assertValidKey("kvtest:ping"), /invalid_kv_key/);
  assert.equal(assertValidKey("kvtest/ping"), "kvtest/ping");
});

test("every key produced above matches KEY_PATTERN", () => {
  const produced = [
    keys.flag("dispatch_enabled"),
    keys.customer("+61412345678"),
    keys.job("JA47"),
    keys.jobByCall("v3:abc-123"),
  ];
  for (const k of produced) {
    assert.match(k, KEY_PATTERN);
  }
});
