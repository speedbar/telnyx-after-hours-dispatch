// src/lib/kv-keys.ts
// Single validating helper for every KV key in the project (BUG-002, D10).
// KV keys may contain only a-z A-Z 0-9 - _ / = . — never let a bad key
// reach the service. Pure functions only: no imports, no KV access.

export const KEY_PATTERN = /^[A-Za-z0-9\-_\/=.]+$/;

// Replace every character outside [A-Za-z0-9\-_=.] with "_".
// This includes "/", ":", "+" and spaces, so a "/" inside a segment
// can never create a new path level.
export function sanitizeSegment(input: string): string {
  const out = input.replace(/[^A-Za-z0-9\-_=.]/g, "_");
  if (out === "") {
    throw new Error("invalid_kv_segment");
  }
  return out;
}

export function assertValidKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error("invalid_kv_key");
  }
  // TODO(VERIFY): no maximum length enforced — the service limit is unknown.
  return key;
}

export const keys = {
  flag: (name: string): string =>
    assertValidKey("flag/" + sanitizeSegment(name)),
  customer: (e164: string): string =>
    assertValidKey("cust/" + sanitizeSegment(e164.replace(/^\+/, ""))),
  job: (jobId: string): string =>
    assertValidKey("job/" + sanitizeSegment(jobId)),
  jobByCall: (callRef: string): string =>
    assertValidKey("job-by-call/" + sanitizeSegment(callRef)),
};
