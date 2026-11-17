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
}

export function formatLine(fields: LogFields, now: Date = new Date()): string {
  const error =
    fields.error === undefined || fields.error === null
      ? null
      : fields.error.length > 300
        ? fields.error.slice(0, 300)
        : fields.error;
  // Key order below is part of the contract: exactly these 15 keys,
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
  });
}

export function log(fields: LogFields): void {
  // TODO(VERIFY): LOG_LEVEL filtering is not implemented yet.
  console.log(formatLine(fields));
}

export function newRequestId(): string {
  return crypto.randomUUID();
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
