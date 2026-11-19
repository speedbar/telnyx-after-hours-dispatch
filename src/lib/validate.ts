// src/lib/validate.ts
// Boundary validation for untrusted model output. Business failures are
// returned as data, never thrown (these helpers return null). Web APIs only.

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const out = v.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (out === "" || out.length > max) return null;
  return out;
}

const CALL_REF_RE = /^[A-Za-z0-9:_\-.=]{1,128}$/;
const JOB_ID_RE = /^J[A-Z0-9]{5}$/;

export function isCallRef(v: unknown): v is string {
  return typeof v === "string" && CALL_REF_RE.test(v);
}

export function isJobId(v: unknown): v is string {
  return typeof v === "string" && JOB_ID_RE.test(v);
}

// A safe call ref for actor names and logs: "c:" + 32 hex of the SHA-256 of
// whatever identity string we got (conversation id, SIP address, model value).
// Always satisfies CALL_REF_RE; a stable hash, never the raw value.
async function safeCallRef(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return "c:" + hex.slice(0, 32);
}

export interface CallRefResolution {
  ref: string | null;
  source: "meta" | "args" | "none";
}

// Server-side call identity (S1.5): the model is never trusted to carry IDs.
// Order: the conversation id from tools/call _meta, else args.call_ref
// (non-empty string of at most 200 chars), else null. A mismatching model
// value is ignored silently.
export async function resolveCallRef(
  args: unknown,
  ctx: { meta_conversation_id?: string } | undefined,
): Promise<CallRefResolution> {
  const metaId = ctx?.meta_conversation_id;
  if (typeof metaId === "string" && metaId !== "") {
    return { ref: await safeCallRef(metaId), source: "meta" };
  }
  const v =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).call_ref
      : undefined;
  if (typeof v === "string" && v !== "" && v.length <= 200) {
    return { ref: await safeCallRef(v), source: "args" };
  }
  return { ref: null, source: "none" };
}

export function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

// Normalise to digits only (no plus). Leading "0" becomes "61" (AU mobile).
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/[\s\-().]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^[0-9]+$/.test(s)) return null;
  if (s.startsWith("0")) s = "61" + s.slice(1);
  if (s.length < 8 || s.length > 15) return null;
  return s;
}

const JOB_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

// Deterministic job id from the call ref: "JA" + 4 chars from the SHA-256.
export async function jobIdFromCallRef(callRef: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(callRef),
  );
  const bytes = new Uint8Array(digest);
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += JOB_ALPHABET[bytes[i] % 30];
  }
  return "JA" + suffix;
}

// Spoken form for the voice flow: "J A 4 F 7 C".
export function spoken(jobId: string): string {
  return jobId.split("").join(" ");
}
