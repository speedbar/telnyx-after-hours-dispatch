// tests/techphones.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTechPhones } from "../src/lib/techphones.js";

test("loads and normalises a valid map", () => {
  const r = loadTechPhones(
    JSON.stringify({ "tech-01": "+61 412-345-678", "tech-02": "0434 567 890" }),
  );
  assert.deepEqual(r.phones, {
    "tech-01": "61412345678",
    "tech-02": "61434567890",
  });
  assert.deepEqual(r.invalid, []);
});

test("bad entries collect ids only (never values)", () => {
  const r = loadTechPhones(
    JSON.stringify({
      "tech-01": "+61412345678",
      "tech-02": "0412", // too short
      "tech-03": 12345, // not a string
      "tech-04": "55555555555", // all-same digit guard
    }),
  );
  assert.deepEqual(r.phones, { "tech-01": "61412345678" });
  assert.deepEqual(r.invalid.sort(), ["tech-02", "tech-03", "tech-04"]);
});

test("never throws: missing, empty, malformed or non-map input all give empty", () => {
  assert.deepEqual(loadTechPhones(undefined), { phones: {}, invalid: [] });
  assert.deepEqual(loadTechPhones(""), { phones: {}, invalid: [] });
  assert.deepEqual(loadTechPhones("{not json"), { phones: {}, invalid: [] });
  assert.deepEqual(loadTechPhones("123"), { phones: {}, invalid: [] });
  assert.deepEqual(loadTechPhones('["+61412345678"]'), { phones: {}, invalid: [] });
  assert.deepEqual(loadTechPhones("null"), { phones: {}, invalid: [] });
});
