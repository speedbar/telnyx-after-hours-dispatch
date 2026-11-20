// src/lib/log.ts
// Structured logger: one JSON object per line on stdout.
// This file is the ONLY place in src/ that may call console.log (AGENTS.md).
// Never log full phone numbers (hash them via callerHash) or secrets.
// Pure Web APIs only (crypto.subtle, crypto.randomUUID, performance.now) —
// no node:crypto import so the file runs in the Edge runtime.

export type LogLevel = "info" | "warn" | "error";
export type Component = "dv" | "mcp" | "actor" | "events" | "ops";
export type Outcome = "ok" | "fail" | "degraded" | "rejected";

// Deliberately NO field for a raw phone number.
export interface LogFields {
  component: Component;
  event: string;
  level?: LogLevel;
  request_id?: string;
  call_ref?: string;
  caller_hash?: string;
  node?: string;
  tool?: string;
  outcome?: Outcome;
  latency_ms?: number;
  error?: string;
  attempt?: number;
  technician_id?: string;
  job_id?: string;
  bad_fields?: string; // comma-joined validation-failed field names, never values
  meta_keys?: string; // comma-joined key names of tools/call _meta, names only
  call_ref_source?: "meta" | "args" | "none";
  eligible_count?: number; // technician pool size after trade eligibility (count only)
  flags?: string; // comma-joined soft-validation flag names, names only
  conv_hash?: string; // 12 hex, salted hash of the Telnyx conversation id
  urgency_from?: "emergency" | "urgent"; // urgency_raised: enum values only
  urgency_to?: "emergency" | "urgent";
  floor_reason?: string; // fixed floor category (gas, flood, ...), never caller words
  hop_flag_ms?: number; // S1.9: per-hop timings (Date.now() differences)
  hop_job_get_ms?: number;
  hop_tech_ms?: number;
  hop_job_open_ms?: number;
  hop_tech_status_ms?: number;
  hop_brief_ms?: number;
  hop_mark_booked_ms?: number; // S1.9b
  hop_job_write_ms?: number; // S1.9b: same await as hop_brief_ms (the job write)
  flag_source?: "kv" | "cache" | "default" | "timeout"; // S1.9b: where the flag came from
  boot_age_ms?: number; // S1.9b: ms since this instance's module boot
  first_request?: boolean; // S1.9b: true exactly once per instance
}

export function formatLine(fields: LogFields, now: Date = new Date()): string {
  const error =
    fields.error === undefined || fields.error === null
      ? null
      : fields.error.length > 300
        ? fields.error.slice(0, 300)
        : fields.error;
  // Key order below is part of the contract: exactly these keys,
  // in this order, with null for anything not supplied.
  return JSON.stringify({
    ts: now.toISOString(),
    level: fields.level ?? "info",
    request_id: fields.request_id ?? null,
    call_ref: fields.call_ref ?? null,
    caller_hash: fields.caller_hash ?? null,
    component: fields.component,
    node: fields.node ?? null,
    event: fields.event,
    tool: fields.tool ?? null,
    outcome: fields.outcome ?? null,
    latency_ms: fields.latency_ms ?? null,
    error,
    attempt: fields.attempt ?? null,
    technician_id: fields.technician_id ?? null,
    job_id: fields.job_id ?? null,
    bad_fields: fields.bad_fields ?? null,
    meta_keys: fields.meta_keys ?? null,
    call_ref_source: fields.call_ref_source ?? null,
    eligible_count: fields.eligible_count ?? null,
    flags: fields.flags ?? null,
    conv_hash: fields.conv_hash ?? null,
    urgency_from: fields.urgency_from ?? null,
    urgency_to: fields.urgency_to ?? null,
    floor_reason: fields.floor_reason ?? null,
    hop_flag_ms: fields.hop_flag_ms ?? null,
    hop_job_get_ms: fields.hop_job_get_ms ?? null,
    hop_tech_ms: fields.hop_tech_ms ?? null,
    hop_job_open_ms: fields.hop_job_open_ms ?? null,
    hop_tech_status_ms: fields.hop_tech_status_ms ?? null,
    hop_brief_ms: fields.hop_brief_ms ?? null,
    hop_mark_booked_ms: fields.hop_mark_booked_ms ?? null,
    hop_job_write_ms: fields.hop_job_write_ms ?? null,
    flag_source: fields.flag_source ?? null,
    boot_age_ms: fields.boot_age_ms ?? null,
    first_request: fields.first_request ?? null,
  });
}

// Per-tool-call log context (S1.9): carried on the opaque ctx object via a
// WeakMap so the ctx shape handlers (and tests) see is unchanged. Ids and
// numbers only, never argument values.
export interface ToolLogCtx {
  request_id?: string;
  conv_hash?: string;
  technician_id?: string;
  hop_flag_ms?: number;
  hop_job_get_ms?: number;
  hop_tech_ms?: number;
  hop_job_open_ms?: number;
  hop_tech_status_ms?: number;
  hop_brief_ms?: number;
  hop_mark_booked_ms?: number;
  hop_job_write_ms?: number;
  flag_source?: "kv" | "cache" | "default" | "timeout";
  eligible_count?: number;
}
const toolLogCtx = new WeakMap<object, ToolLogCtx>();

export function setToolLogCtx(ctx: object, fields: ToolLogCtx): void {
  toolLogCtx.set(ctx, { ...toolLogCtx.get(ctx), ...fields });
}

export function toolLogCtxOf(ctx: object | undefined): ToolLogCtx {
  if (ctx === undefined || ctx === null || typeof ctx !== "object") return {};
  return toolLogCtx.get(ctx) ?? {};
}

export function log(fields: LogFields): void {
  // TODO(VERIFY): LOG_LEVEL filtering is not implemented yet.
  console.log(formatLine(fields));
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

// S1.9b: instance boot diagnostics. BOOT_AT is set when this module is first
// evaluated (function instance boot); first_request is true exactly once, for
// the first request this instance serves (the check-and-set is synchronous).
const BOOT_AT = Date.now();
let firstRequestServed = false;

export function bootFields(): { boot_age_ms: number; first_request: boolean } {
  const first_request = !firstRequestServed;
  firstRequestServed = true;
  return { boot_age_ms: Math.max(0, Date.now() - BOOT_AT), first_request };
}

// SHA-256 of salt + e164, lowercase hex, first 12 characters.
export async function callerHash(e164: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(salt + e164);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return hex.slice(0, 12);
}

export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; latency_ms: number }> {
  const start = performance.now();
  const result = await fn(); // errors propagate to the caller
  const latency_ms = Math.max(0, Math.round(performance.now() - start));
  return { result, latency_ms };
}
