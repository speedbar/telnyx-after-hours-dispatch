// src/lib/sig.ts
// Telnyx webhook signature check (Ed25519). The signed message is the string
// `${timestamp}|${rawBody}`. The telnyx-signature-ed25519 (base64) and
// telnyx-timestamp headers are read by the caller, not by this file.
// Pure Web APIs only (crypto.subtle, atob, TextEncoder) — no node:crypto.
// This function must never throw: every failure becomes a VerifyResult.

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_headers" | "stale_timestamp" | "bad_signature" | "bad_key";
    };

// Standard-base64 decode via atob; throws on any character outside the
// base64 alphabet (callers treat a throw as invalid input).
function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function verifyTelnyx(
  rawBody: string,
  signatureB64: string | null,
  timestamp: string | null,
  publicKeyB64: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  // 1. Headers must be present.
  if (!signatureB64 || !timestamp) {
    return { ok: false, reason: "missing_headers" };
  }

  // 2. Timestamp is an integer number of SECONDS since the epoch.
  // TODO(VERIFY): confirm the unit against a real Telnyx webhook in S1.2/S2.1.
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > 300) {
    return { ok: false, reason: "stale_timestamp" };
  }

  // 3. Import the public key. Any failure — bad base64, wrong length,
  // unsupported algorithm — is "bad_key". There is no fallback library:
  // if the runtime does not support Ed25519 we log "bad_key" as a bug.
  let key: CryptoKey;
  try {
    const keyBytes = decodeBase64(publicKeyB64);
    if (keyBytes.byteLength !== 32) {
      throw new Error("bad_key_length");
    }
    key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, [
      "verify",
    ]);
  } catch {
    return { ok: false, reason: "bad_key" };
  }

  // 4. Verify the signature over `${timestamp}|${rawBody}`. The raw timestamp
  // string is what Telnyx signed, so it is used verbatim here.
  try {
    const sigBytes = decodeBase64(signatureB64);
    const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    const valid = await crypto.subtle.verify("Ed25519", key, sigBytes, message);
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
