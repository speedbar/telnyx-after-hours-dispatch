// tests/briefurgency.test.ts
// D20b-3: the brief speaks the stored urgency value (first letter capitalised),
// never a mapped word; an empty urgency is omitted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../src/lib/brief.js";

const BASE = { job_id: "JXXXXXX", trade: "plumbing", suburb: "Newtown", address: "12 Quay Street" };

test("stored urgencies spoken as-is: Emergency / Urgent, never Routine", () => {
  const em = buildBrief({ ...BASE, urgency: "emergency" });
  assert.ok(em.includes("Emergency plumbing job in Newtown, 12 Quay Street."));
  const ur = buildBrief({ ...BASE, urgency: "urgent" });
  assert.ok(ur.includes("Urgent plumbing job in Newtown, 12 Quay Street."));
  assert.ok(!em.includes("Routine") && !ur.includes("Routine"), "never Routine");
});

test("empty or whitespace-only urgency omitted, job fragment capitalised", () => {
  const expect =
    "Hi, Harbour Trades After-Hours dispatch. Plumbing job in Newtown, 12 Quay Street. " +
    "Press 1 to accept, or 2 to decline.";
  assert.equal(buildBrief({ ...BASE, urgency: "" }), expect);
  assert.equal(buildBrief({ ...BASE, urgency: " \n\t " }), expect);
});

test("unknown urgency passed through capitalised and cleaned", () => {
  const b = buildBrief({ ...BASE, urgency: "same\nday" });
  assert.ok(b.includes("Same day plumbing job in Newtown, 12 Quay Street."));
});
