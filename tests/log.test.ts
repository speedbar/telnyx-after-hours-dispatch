// tests/log.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callerHash,
  formatLine,
  newRequestId,
  timed,
} from "../src/lib/log.js";

const EXPECTED_KEYS = [
  "ts",
  "level",
  "request_id",
  "call_ref",
  "caller_hash",
  "component",
  "node",
  "event",
  "tool",
  "outcome",
  "latency_ms",
  "error",
  "attempt",
  "technician_id",
  "job_id",
];

test("formatLine output parses as JSON with exactly the 15 keys in order", () => {
  const line = formatLine(
    {
      component: "mcp",
      event: "tool_call",
      level: "warn",
      request_id: "r-1",
      call_ref: "v3_abc",
      caller_hash: "0123456789ab",
      node: "triage",
      tool: "lookup_customer",
      outcome: "ok",
      latency_ms: 12,
      error: "boom",
      attempt: 2,
      technician_id: "tech-01",
      job_id: "JA47",
    },
    new Date("2026-11-18T00:00:00.000Z"),
  );
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), EXPECTED_KEYS);
});

test("minimal fields: level defaults to info, every other field is null", () => {
  const now = new Date("2026-11-18T01:02:03.456Z");
  const parsed = JSON.parse(
    formatLine({ component: "dv", event: "dv_in" }, now),
  );
  assert.equal(parsed.ts, now.toISOString());
  assert.equal(parsed.level, "info");
  assert.equal(parsed.component, "dv");
  assert.equal(parsed.event, "dv_in");
  for (const key of Object.keys(parsed)) {
    if (["ts", "level", "component", "event"].includes(key)) continue;
    assert.equal(parsed[key], null, `${key} should be null`);
  }
});

test("an error of 500 characters is truncated to 300", () => {
  const parsed = JSON.parse(
    formatLine({ component: "ops", event: "x", error: "e".repeat(500) }),
  );
  assert.equal(parsed.error.length, 300);
});

test("callerHash: 12 lowercase hex chars, stable, salted, no phone digits", async () => {
  const h1 = await callerHash("+61412345678", "salt");
  const h2 = await callerHash("+61412345678", "salt");
  const h3 = await callerHash("+61412345678", "other-salt");
  assert.match(h1, /^[0-9a-f]{12}$/);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.ok(
    !h1.includes("61412345678"),
    "hash must not contain the digits of the phone number",
  );
});

test("newRequestId returns a UUID", () => {
  assert.match(
    newRequestId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("timed returns the result and a non-negative integer latency_ms", async () => {
  const { result, latency_ms } = await timed(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 42;
  });
  assert.equal(result, 42);
  assert.ok(Number.isInteger(latency_ms), "latency_ms must be an integer");
  assert.ok(latency_ms >= 0, "latency_ms must never be negative");
});
