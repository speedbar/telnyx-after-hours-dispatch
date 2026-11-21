// tests/smslayout.test.ts
// D20b-2 SMS layout: one item per line; HAZARD first, never cut; Details is
// the only truncated field; total at or under SMS_MAX_LEN. Pure template tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAcceptSms, SMS_MAX_LEN, type AcceptSmsJob } from "../src/lib/sms.js";

const JOB: AcceptSmsJob = {
  job_id: "JA4F7C",
  urgency: "emergency",
  trade: "plumber",
  suburb: "Footscray",
  customer_name: "Sam Chen",
  address: "12 Example Street",
  contact_phone: "61412345678",
  details: "Burst pipe under the kitchen sink",
  hazards: "water near electrics",
};

test("layout: header lines, HAZARD before Customer, exact line order", () => {
  const lines = buildAcceptSms(JOB).split("\n");
  assert.deepEqual(lines, [
    "Harbour Trades After-Hours - Job JA4F7C",
    "Emergency plumber",
    "HAZARD: water near electrics",
    "Customer: Sam Chen",
    "Phone: 0412345678",
    "Address: 12 Example Street, Footscray",
    "Details: Burst pipe under the kitchen sink",
    "Do not reply.",
  ]);
});

test("urgency and trade: stored values, only the first letter capitalised, no mapping", () => {
  assert.ok(buildAcceptSms({ ...JOB, urgency: "emergency", trade: "plumber" }).includes("\nEmergency plumber\n"));
  assert.ok(buildAcceptSms({ ...JOB, urgency: "standard", trade: "electrical" }).includes("\nStandard electrical\n"));
});

test("hazards: 'none' (any case), empty or absent omits the line", () => {
  for (const h of ["none", "None", "NONE", " none ", ""]) {
    assert.ok(!buildAcceptSms({ ...JOB, hazards: h }).includes("HAZARD"), `hazards ${h} omitted`);
  }
  const bare: AcceptSmsJob = { ...JOB };
  delete bare.hazards;
  assert.ok(!buildAcceptSms(bare).includes("HAZARD"), "hazards field absent");
});

test("hazards printed whole; only Details is cut to keep the total at or under 320", () => {
  const hazard = "live wires down near the switchboard"; // long enough to matter
  const detail = "d".repeat(500);
  const b = buildAcceptSms({ ...JOB, hazards: hazard, details: detail });
  assert.ok(b.includes("HAZARD: " + hazard), "hazards in full, never truncated");
  assert.ok(b.length <= SMS_MAX_LEN, "total at the cap");
  assert.ok(!b.includes(detail), "details truncated instead");
  assert.ok(b.endsWith("\nDo not reply."));
});

test("address: suburb appended once, omitted when empty or already inside the address", () => {
  const withSuburb = buildAcceptSms({ ...JOB, address: "12 Example Street", suburb: "Footscray" });
  assert.ok(withSuburb.includes("Address: 12 Example Street, Footscray"));
  const already = buildAcceptSms({ ...JOB, address: "12 Example Street, Footscray", suburb: "Footscray" });
  const lines = already.split("\n").filter((l) => l.startsWith("Address: "));
  assert.deepEqual(lines, ["Address: 12 Example Street, Footscray"], "suburb not duplicated");
  const noSuburb = buildAcceptSms({ ...JOB, suburb: "" });
  assert.ok(noSuburb.includes("Address: 12 Example Street\n"), "no trailing comma");
});

test("optional lines omitted when empty; Details line dropped only when it cannot fit", () => {
  const b = buildAcceptSms({ job_id: "JA4F7C", urgency: "urgent", trade: "electrical", suburb: "Geelong" });
  assert.deepEqual(b.split("\n"), [
    "Harbour Trades After-Hours - Job JA4F7C",
    "Urgent electrical",
    "Do not reply.",
  ]);
});

test("newlines and control chars inside values collapse to single spaces", () => {
  const b = buildAcceptSms({
    ...JOB,
    hazards: "gas\nsmell\tin\u0000 kitchen",
    customer_name: "Sam\nChen",
    details: "pipe\nburst",
  });
  assert.ok(b.includes("HAZARD: gas smell in kitchen"));
  assert.ok(b.includes("Customer: Sam Chen"));
  assert.ok(b.includes("Details: pipe burst"));
});

test("details alone bears the cut: oversized details, everything else intact", () => {
  const detail = "d".repeat(2000);
  const b = buildAcceptSms({ ...JOB, details: detail });
  assert.ok(b.length <= SMS_MAX_LEN);
  const lines = b.split("\n");
  assert.equal(lines[0], "Harbour Trades After-Hours - Job JA4F7C");
  assert.equal(lines[2], "HAZARD: water near electrics");
  assert.ok(lines[lines.length - 2].startsWith("Details: ") && !b.includes(detail));
  assert.equal(lines[lines.length - 1], "Do not reply.");
});
