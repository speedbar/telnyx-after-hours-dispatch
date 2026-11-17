// tests/sig.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTelnyx } from "../src/lib/sig.js";

// Fixed "now" for determinism (an integer number of seconds).
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const BODY = '{"event":"call.started"}';

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

test("valid signature and current timestamp -> ok", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S);
  const sig = await sign(privateKey, timestamp, BODY);
  const result = await verifyTelnyx(BODY, sig, timestamp, publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: true });
});

test("body changed by one character -> bad_signature", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S);
  const sig = await sign(privateKey, timestamp, BODY);
  const tampered = BODY.slice(0, -1) + "x";
  const result = await verifyTelnyx(tampered, sig, timestamp, publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("timestamp 301 s old -> stale_timestamp", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S - 301);
  const sig = await sign(privateKey, timestamp, BODY);
  const result = await verifyTelnyx(BODY, sig, timestamp, publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
});

test("timestamp 299 s old, signed for that timestamp -> ok", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S - 299);
  const sig = await sign(privateKey, timestamp, BODY);
  const result = await verifyTelnyx(BODY, sig, timestamp, publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: true });
});

test("timestamp 301 s in the future -> stale_timestamp", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S + 301);
  const sig = await sign(privateKey, timestamp, BODY);
  const result = await verifyTelnyx(BODY, sig, timestamp, publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
});

test("null signature or empty timestamp -> missing_headers", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S);
  const sig = await sign(privateKey, timestamp, BODY);
  assert.deepEqual(
    await verifyTelnyx(BODY, null, timestamp, publicKeyB64, NOW_MS),
    { ok: false, reason: "missing_headers" },
  );
  assert.deepEqual(
    await verifyTelnyx(BODY, sig, "", publicKeyB64, NOW_MS),
    { ok: false, reason: "missing_headers" },
  );
});

test("invalid base64 key or 31-byte key -> bad_key", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  void publicKeyB64;
  const timestamp = String(NOW_S);
  const sig = await sign(privateKey, timestamp, BODY);
  assert.deepEqual(
    await verifyTelnyx(BODY, sig, timestamp, "not-base64!!", NOW_MS),
    { ok: false, reason: "bad_key" },
  );
  const thirtyOneBytes = Buffer.alloc(31).toString("base64");
  assert.deepEqual(
    await verifyTelnyx(BODY, sig, timestamp, thirtyOneBytes, NOW_MS),
    { ok: false, reason: "bad_key" },
  );
});

test("signature that is not base64 -> bad_signature", async () => {
  const { publicKeyB64 } = await fixture;
  const timestamp = String(NOW_S);
  const result = await verifyTelnyx(BODY, "###", timestamp, publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("non-numeric timestamp -> stale_timestamp", async () => {
  const { privateKey, publicKeyB64 } = await fixture;
  const sig = await sign(privateKey, "abc", BODY);
  const result = await verifyTelnyx(BODY, sig, "abc", publicKeyB64, NOW_MS);
  assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
});
