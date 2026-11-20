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

const ALL_SAME = /^(\d)\1+$/;

// Callback hard reject: only what makes the job impossible (an undiallable
// number). Runs after normalisePhone; returns the normalised digits or null.
// Non-AU numbers that pass normalisePhone stay accepted (caller may be abroad).
export function dialableCallback(raw: unknown): string | null {
  const s = normalisePhone(raw);
  if (s === null) return null;
  // An AU number must be exactly 11 digits after the 0 -> 61 rewrite
  // (rejects 0412345, which normalises to the 8-digit 61412345).
  if (s.startsWith("61") && s.length !== 11) return null;
  // Emergency or service numbers, and anything of 6 or fewer digits.
  if (s === "000" || s === "112" || s === "106" || s.length <= 6) return null;
  // All same digit is fake ("2222222222"). Checked on the raw digits too,
  // because the 0 -> 61 rewrite would mask an all-zero input ("0000000000").
  if (ALL_SAME.test(s)) return null;
  const rawDigits = (raw as string).replace(/\D/g, "");
  if (rawDigits.length > 0 && ALL_SAME.test(rawDigits)) return null;
  return s;
}

// Digits -> E.164 for the Telnyx API. Input must already be normalised digits
// (from normalisePhone / dialableCallback); this adds the plus, nothing more.
export function toE164(digits: string): string {
  return "+" + digits;
}

// Whole-word (case-insensitive) match, so "gaslight" does not match "gas".
const wordHit = (lower: string, w: string): boolean =>
  new RegExp(`\\b${w}\\b`).test(lower);

const EMERGENCY_WORDS = [
  "gas",
  "smoke",
  "spark",
  "sparks",
  "sparking",
  "burning",
  "electrocuted",
  "shock",
  "flood",
  "flooding",
  "burst",
  "sewage",
  "fire",
  "carbon monoxide",
] as const;

// Severity and trade floors (S1.8): the model's values are never lowered.
// Conservative on purpose: any "gas" mention routes to a gas-licensed
// technician and is treated as an emergency (D19).
export function applyFloors(
  trade: string,
  urgency: string,
  summary: string,
): { trade: string; urgency: string; raised: boolean; corrected: boolean } {
  const lower = summary.toLowerCase();
  let t = trade;
  let u = urgency;
  let raised = false;
  let corrected = false;
  if (u !== "emergency" && EMERGENCY_WORDS.some((w) => wordHit(lower, w))) {
    u = "emergency";
    raised = true;
  }
  if (t !== "gas" && wordHit(lower, "gas")) {
    t = "gas";
    corrected = true;
  }
  if (t === "gas" && u !== "emergency") {
    u = "emergency";
    raised = true;
  }
  return { trade: t, urgency: u, raised, corrected };
}

// Soft flags (S1.8): accept the job, attach flag names for a human review.
// Computed from the cleaned inputs; names only, never logged with values.
export function jobFlags(args: {
  customer_name: string;
  address: string;
  suburb: string;
}): string[] {
  const flags: string[] = [];
  if (!/\d/.test(args.address)) flags.push("address_no_house_number");
  if (args.address.length < 8) flags.push("address_short");
  if (args.customer_name.length < 2) flags.push("name_short");
  if (/\d/.test(args.suburb)) flags.push("suburb_numeric");
  return flags;
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
