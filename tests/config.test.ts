// tests/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/lib/config.js";

const UNIQUE = "READCONFIG_TEST_7f3b9d2a_UNIQUE";

test("readConfig returns the value from the env object when present", () => {
  assert.equal(readConfig({ [UNIQUE]: "from-env-object" }, UNIQUE), "from-env-object");
});

test("readConfig falls back to process.env when the env object lacks it", () => {
  const key = "READCONFIG_TEST_FALLBACK_1a2b3c";
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  process.env[key] = "from-process-env";
  try {
    assert.equal(readConfig({}, key), "from-process-env");
    // The env object wins over process.env when both are set.
    assert.equal(readConfig({ [key]: "from-env-object" }, key), "from-env-object");
  } finally {
    if (had) {
      process.env[key] = previous;
    } else {
      delete process.env[key];
    }
    assert.equal(readConfig({}, key), undefined);
  }
});

test("readConfig returns undefined when unset, for empty strings, and never throws", () => {
  assert.equal(readConfig({}, UNIQUE), undefined);
  assert.equal(readConfig({ [UNIQUE]: "" }, UNIQUE), undefined);
  assert.equal(readConfig(null, UNIQUE), undefined);
  assert.equal(readConfig(undefined, UNIQUE), undefined);
  assert.equal(readConfig(42, UNIQUE), undefined);
  assert.equal(readConfig("a string", UNIQUE), undefined);
});
