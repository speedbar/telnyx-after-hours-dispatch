// tests/dv.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleDv,
  type DirectoryStub,
  type DvEnv,
  type LookupResult,
} from "../src/routes/dv.js";
import { callerHash } from "../src/lib/log.js";

// Fixed "now" for determinism (an integer number of seconds).
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const PHONE = "+61491570006";
const PHONE_DIGITS = "61491570006";
const CALL_REF = "v3:sim-test-001";
const SALT = "dv-test-salt";

const CUSTOMER = {
  customer_id: "cust_001",
  name: "Ada Lovelace",
  address: "12 Quay St, Wollongong",
  site_notes: "Gate code 1234",
  after_hours_contract: true,
};

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

// One shared fixture per file; created once, reused by every test.
const fixture = makeKeyPair();

function makeBody(extraPayload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      event_type: "assistant.initialization",
      payload: {
        telnyx_end_user_target: PHONE,
        call_control_id: CALL_REF,
        assistant_id: "asst_test",
        ...extraPayload,
      },
    },
  });
}

interface LookupCall {
  phoneDigits: string;
  flagName: string;
}

// DIRECTORY fake: records calls and returns a fixed result. fn overrides the
// result entirely (e.g. a rejection or a promise that never resolves).
function fakeDirectory(
  result: LookupResult,
  calls: LookupCall[] = [],
  fn?: DirectoryStub["lookup"],
): DvEnv["DIRECTORY"] {
  return {
    idFromName(_name: string): DirectoryStub {
      return {
        lookup:
          fn ??
          ((phoneDigits: string, flagName: string) => {
            calls.push({ phoneDigits, flagName });
            return Promise.resolve(result);
          }),
      };
    },
  };
}

function makeEnv(
  publicKeyB64: string,
  directory: DvEnv["DIRECTORY"],
  extras: Record<string, unknown> = {},
): DvEnv {
  return {
    DIRECTORY: directory,
    TELNYX_PUBLIC_KEY: publicKeyB64,
    LOG_SALT: SALT,
    ...extras,
  };
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

function signedRequest(body: string, sig: string, timestamp: string): Request {
  return new Request("https://test.invalid/dv", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": sig,
      "telnyx-timestamp": timestamp,
    },
  });
}

async function variablesOf(res: Response): Promise<Record<string, string>> {
  const json = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json), ["dynamic_variables"]);
  return json.dynamic_variables as Record<string, string>;
}

test("1. known caller: 200, dynamic_variables only, string values, customer fields", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const calls: LookupCall[] = [];
  const directory = fakeDirectory(
    { flag: "true", customer: JSON.stringify(CUSTOMER) },
    calls,
  );
  const env = makeEnv(publicKeyB64, directory);
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const vars = await variablesOf(res);
    for (const [key, value] of Object.entries(vars)) {
      assert.equal(typeof value, "string", `${key} must be a string`);
    }
    assert.equal(vars.caller_known, "true");
    assert.equal(vars.customer_name, CUSTOMER.name);
    assert.equal(vars.customer_address, CUSTOMER.address);
    assert.equal(vars.call_ref, CALL_REF);
    assert.equal(vars.dispatch_enabled, "true");
    // The flag and the customer come from exactly one actor lookup.
    assert.deepEqual(calls, [
      { phoneDigits: PHONE_DIGITS, flagName: "dispatch_enabled" },
    ]);
    // A dv_lookup log line records the timed tool call.
    const dvLookup = parsed(cap.lines).find((l) => l.event === "dv_lookup");
    assert.ok(dvLookup, "expected a dv_lookup log line");
    assert.equal(dvLookup.tool, "actor.lookup");
    assert.equal(dvLookup.outcome, "ok");
    assert.equal(typeof dvLookup.latency_ms, "number");
    // S1.9b: dv_in carries the instance boot facts; this is the instance's
    // first request in this file's process.
    const dvIn = parsed(cap.lines).find((l) => l.event === "dv_in");
    assert.ok(dvIn, "expected a dv_in log line");
    assert.equal(dvIn.first_request, true);
    assert.equal(typeof dvIn.boot_age_ms, "number");
    assert.ok((dvIn.boot_age_ms as number) >= 0);
  } finally {
    cap.restore();
  }
});

test("2. unknown caller: caller_known false, empty customer fields", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const env = makeEnv(
    publicKeyB64,
    fakeDirectory({ flag: "true", customer: null }),
  );
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
    assert.equal(res.status, 200);
    const vars = await variablesOf(res);
    assert.equal(vars.caller_known, "false");
    assert.equal(vars.customer_name, "");
    assert.equal(vars.customer_address, "");
    // S1.9b: second request of the file's process -> first_request false.
    const dvIn = parsed(cap.lines).find((l) => l.event === "dv_in");
    assert.equal(dvIn?.first_request, false);
    assert.equal(typeof dvIn?.boot_age_ms, "number");
  } finally {
    cap.restore();
  }
});

test("3. no signature headers: 403 forbidden body and a sig_fail log line", async () => {
  const { publicKeyB64 } = await fixture;
  const env = makeEnv(publicKeyB64, fakeDirectory({ flag: null, customer: null }));
  const cap = captureLog();
  try {
    const req = new Request("https://test.invalid/dv", {
      method: "POST",
      body: makeBody(),
    });
    const res = await handleDv(req, env, NOW_MS);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    assert.ok(
      parsed(cap.lines).some((l) => l.event === "sig_fail"),
      "expected a sig_fail log line",
    );
  } finally {
    cap.restore();
  }
});

test("4. tampered body -> 403; stale timestamp (10 min old) -> 403", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const env = makeEnv(publicKeyB64, fakeDirectory({ flag: null, customer: null }));
  const body = makeBody();
  const ts = String(NOW_S);
  const cap = captureLog();
  try {
    // Tampered: sign the real body, then change one character.
    const sig = await sign(privateKey, ts, body);
    const tampered = body.slice(0, -1) + "x";
    const resTampered = await handleDv(
      signedRequest(tampered, sig, ts),
      env,
      NOW_MS,
    );
    assert.equal(resTampered.status, 403);
    assert.deepEqual(await resTampered.json(), {
      ok: false,
      error: "forbidden",
    });

    // Stale: timestamp 600 s in the past, signed for that timestamp.
    const staleTs = String(NOW_S - 600);
    const staleSig = await sign(privateKey, staleTs, body);
    const resStale = await handleDv(
      signedRequest(body, staleSig, staleTs),
      env,
      NOW_MS,
    );
    assert.equal(resStale.status, 403);
    assert.deepEqual(await resStale.json(), { ok: false, error: "forbidden" });
  } finally {
    cap.restore();
  }
});

test("5. dispatch flag: stored 'false' -> 'false'; missing -> 'true'", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const offEnv = makeEnv(
      publicKeyB64,
      fakeDirectory({ flag: "false", customer: null }),
    );
    const resOff = await handleDv(signedRequest(body, sig, ts), offEnv, NOW_MS);
    assert.equal((await variablesOf(resOff)).dispatch_enabled, "false");

    const missingEnv = makeEnv(
      publicKeyB64,
      fakeDirectory({ flag: null, customer: null }),
    );
    const resMissing = await handleDv(
      signedRequest(body, sig, ts),
      missingEnv,
      NOW_MS,
    );
    assert.equal((await variablesOf(resMissing)).dispatch_enabled, "true");
  } finally {
    cap.restore();
  }
});

test("6. actor lookup throws: 200 with safe defaults and a dv_degraded log line", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const directory = fakeDirectory(
    { flag: null, customer: null },
    [],
    () => Promise.reject(new Error("actor unavailable")),
  );
  const env = makeEnv(publicKeyB64, directory);
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
    assert.equal(res.status, 200);
    const vars = await variablesOf(res);
    assert.equal(vars.dispatch_enabled, "true");
    assert.equal(vars.caller_known, "false");
    assert.equal(vars.customer_name, "");
    assert.equal(vars.call_ref, CALL_REF);
    const events = parsed(cap.lines);
    const degraded = events.find((l) => l.event === "dv_degraded");
    assert.ok(degraded, "expected a dv_degraded log line");
    assert.equal(degraded.error, "lookup_failed:Error");
    const dvOut = events.find((l) => l.event === "dv_out");
    assert.equal(dvOut?.outcome, "degraded");
    const dvLookup = events.find((l) => l.event === "dv_lookup");
    assert.ok(dvLookup, "expected a dv_lookup log line");
    assert.equal(dvLookup.outcome, "fail");
  } finally {
    cap.restore();
  }
});

test("7. GET request: 405 method_not_allowed", async () => {
  const { publicKeyB64 } = await fixture;
  const env = makeEnv(publicKeyB64, fakeDirectory({ flag: null, customer: null }));
  const cap = captureLog();
  try {
    const req = new Request("https://test.invalid/dv", { method: "GET" });
    const res = await handleDv(req, env, NOW_MS);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: "method_not_allowed",
    });
  } finally {
    cap.restore();
  }
});

test("8. TELNYX_PUBLIC_KEY missing: 403, sig_fail log with error no_public_key", async () => {
  const had = Object.prototype.hasOwnProperty.call(
    process.env,
    "TELNYX_PUBLIC_KEY",
  );
  const previous = process.env.TELNYX_PUBLIC_KEY;
  delete process.env.TELNYX_PUBLIC_KEY;
  const cap = captureLog();
  try {
    const env: DvEnv = {
      DIRECTORY: fakeDirectory({ flag: null, customer: null }),
      LOG_SALT: SALT,
    };
    const req = new Request("https://test.invalid/dv", {
      method: "POST",
      body: makeBody(),
    });
    const res = await handleDv(req, env, NOW_MS);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    const sigFail = parsed(cap.lines).find((l) => l.event === "sig_fail");
    assert.ok(sigFail, "expected a sig_fail log line");
    assert.equal(sigFail.error, "no_public_key");
    assert.equal(sigFail.outcome, "rejected");
  } finally {
    cap.restore();
    if (had) {
      process.env.TELNYX_PUBLIC_KEY = previous;
    }
  }
});

test("9. valid signature but body is not JSON: 200 safe defaults + dv_degraded", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const env = makeEnv(publicKeyB64, fakeDirectory({ flag: null, customer: null }));
  const body = "this is not json";
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
    assert.equal(res.status, 200);
    const vars = await variablesOf(res);
    assert.equal(vars.dispatch_enabled, "true");
    assert.equal(vars.caller_known, "false");
    assert.match(vars.call_ref, /^u:[0-9a-f]{12}$/);
    assert.ok(parsed(cap.lines).some((l) => l.event === "dv_degraded"));
  } finally {
    cap.restore();
  }
});

test("10. privacy: salted hash logged, never the phone digits; no salt -> null hash", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const directory = fakeDirectory({
    flag: "true",
    customer: JSON.stringify(CUSTOMER),
  });
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    // With LOG_SALT set.
    const salted = await handleDv(
      signedRequest(body, sig, ts),
      makeEnv(publicKeyB64, directory),
      NOW_MS,
    );
    assert.equal(salted.status, 200);
    await salted.body?.cancel();
    const joined = cap.lines.join("\n");
    assert.ok(
      !joined.includes("61491570006"),
      "no log line may contain the phone digits",
    );
    const dvOut = parsed(cap.lines).find((l) => l.event === "dv_out");
    assert.match(String(dvOut?.caller_hash), /^[0-9a-f]{12}$/);

    // With LOG_SALT missing (also absent from process.env).
    const had = Object.prototype.hasOwnProperty.call(process.env, "LOG_SALT");
    const previous = process.env.LOG_SALT;
    delete process.env.LOG_SALT;
    try {
      cap.lines.length = 0;
      const unsalted = await handleDv(
        signedRequest(body, sig, ts),
        makeEnv(publicKeyB64, directory, { LOG_SALT: undefined }),
        NOW_MS,
      );
      assert.equal(unsalted.status, 200);
      await unsalted.body?.cancel();
      const dvOutNoSalt = parsed(cap.lines).find((l) => l.event === "dv_out");
      assert.equal(dvOutNoSalt?.caller_hash, null);
    } finally {
      if (had) {
        process.env.LOG_SALT = previous;
      }
    }
  } finally {
    cap.restore();
  }
});

test("11. hold_ttl_s comes from DISPATCH_HOLD_TTL_S and defaults to '90'", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const directory = fakeDirectory({ flag: null, customer: null });
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const custom = await handleDv(
      signedRequest(body, sig, ts),
      makeEnv(publicKeyB64, directory, { DISPATCH_HOLD_TTL_S: "45" }),
      NOW_MS,
    );
    assert.equal((await variablesOf(custom)).hold_ttl_s, "45");

    const fallback = await handleDv(
      signedRequest(body, sig, ts),
      makeEnv(publicKeyB64, directory),
      NOW_MS,
    );
    assert.equal((await variablesOf(fallback)).hold_ttl_s, "90");
  } finally {
    cap.restore();
  }
});

test("12. lookup that never resolves: 200 safe defaults, lookup_timeout, within ~1.2 s", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const directory = fakeDirectory(
    { flag: null, customer: null },
    [],
    () => new Promise<LookupResult>(() => {}), // never resolves
  );
  const env = makeEnv(publicKeyB64, directory);
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const started = Date.now();
    // Injected short timeout (50 ms) instead of the real 1000 ms.
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS, 50);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1200, `degraded answer took ${elapsed} ms`);
    assert.equal(res.status, 200);
    const vars = await variablesOf(res);
    assert.equal(vars.dispatch_enabled, "true");
    assert.equal(vars.caller_known, "false");
    assert.equal(vars.call_ref, CALL_REF);
    const events = parsed(cap.lines);
    const degraded = events.find((l) => l.event === "dv_degraded");
    assert.ok(degraded, "expected a dv_degraded log line");
    assert.equal(degraded.error, "lookup_timeout");
    assert.equal(degraded.outcome, "degraded");
    const dvLookup = events.find((l) => l.event === "dv_lookup");
    assert.ok(dvLookup, "expected a dv_lookup log line");
    assert.equal(dvLookup.tool, "actor.lookup");
    assert.equal(dvLookup.outcome, "fail");
    assert.equal(dvLookup.error, "lookup_timeout");
  } finally {
    cap.restore();
  }
});

test("13. FALLBACK_NUMBER set: fallback_number_spoken is the digits spoken in groups", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const env = makeEnv(
    publicKeyB64,
    fakeDirectory({ flag: null, customer: null }),
    { FALLBACK_NUMBER: "+61 (400) 111-222" },
  );
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
    assert.equal(res.status, 200);
    const vars = await variablesOf(res);
    assert.equal(vars.fallback_number_spoken, "6 1 4 0 0 1 1 1 2 2 2");
    assert.ok(
      !parsed(cap.lines).some((l) => l.event === "fallback_number_unset"),
      "no fallback_number_unset log line when the number is set",
    );
  } finally {
    cap.restore();
  }
});

// S1.9 item 5d: conv_hash = salted 12-hex of telnyx_conversation_id on every
// /dv line; another id hashes differently; no id -> null; raw id never logged.
test("15. conv_hash on every dv line; differs per id; null when absent; raw id never logged", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const env = makeEnv(publicKeyB64, fakeDirectory({ flag: "true", customer: null }));
  const ts = String(NOW_S);
  const cap = captureLog();
  try {
    const run = async (bodyExtra: Record<string, unknown>) => {
      const body = makeBody(bodyExtra);
      const sig = await sign(privateKey, ts, body);
      const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
      assert.equal(res.status, 200);
      await res.body?.cancel();
      return parsed(cap.lines.splice(0, cap.lines.length));
    };

    const expected = await callerHash("conv-dv-1", SALT);
    const withId = await run({ telnyx_conversation_id: "conv-dv-1" });
    assert.ok(withId.length > 0);
    for (const l of withId) assert.equal(l.conv_hash, expected, `${l.event} carries conv_hash`);
    assert.ok(!withId.map((l) => JSON.stringify(l)).join("\n").includes("conv-dv-1"), "raw id never logged");

    const other = await run({ telnyx_conversation_id: "conv-dv-2" });
    assert.match(String(other[0]?.conv_hash), /^[0-9a-f]{12}$/);
    assert.notEqual(other[0]?.conv_hash, expected);
    assert.equal(other[0]?.conv_hash, await callerHash("conv-dv-2", SALT));

    const noId = await run({});
    assert.ok(noId.length > 0);
    for (const l of noId) assert.equal(l.conv_hash, null, `${l.event} has null conv_hash`);
  } finally {
    cap.restore();
  }
});

test("14. FALLBACK_NUMBER unset: 'the office' + fallback_number_unset warn log line", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const had = Object.prototype.hasOwnProperty.call(
    process.env,
    "FALLBACK_NUMBER",
  );
  const previous = process.env.FALLBACK_NUMBER;
  delete process.env.FALLBACK_NUMBER;
  const env = makeEnv(
    publicKeyB64,
    fakeDirectory({ flag: null, customer: null }),
  );
  const body = makeBody();
  const ts = String(NOW_S);
  const sig = await sign(privateKey, ts, body);
  const cap = captureLog();
  try {
    const res = await handleDv(signedRequest(body, sig, ts), env, NOW_MS);
    assert.equal(res.status, 200);
    const vars = await variablesOf(res);
    assert.equal(vars.fallback_number_spoken, "the office");
    const unset = parsed(cap.lines).find(
      (l) => l.event === "fallback_number_unset",
    );
    assert.ok(unset, "expected a fallback_number_unset log line");
    assert.equal(unset.level, "warn");
  } finally {
    cap.restore();
    if (had) {
      process.env.FALLBACK_NUMBER = previous;
    }
  }
});
