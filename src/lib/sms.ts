// src/lib/sms.ts
// D20b-1: one SMS with the full job details, texted to the technician who
// pressed 1. The Telnyx send is POST /v2/messages with messaging_profile_id
// and the profile's Alpha sender as `from` (verified in docs/verify-log.md
// V-023 against the Telnyx API reference). Errors are data, never thrown.
// The message body is NEVER logged: dry runs log the length only, failures
// log the reason class only. SMS never decides dispatch state: a failed or
// skipped text changes nothing about the accept.

import { readConfig } from "./config";
import { log } from "./log";
import { checkDialAllowed } from "./ring";
import { toE164 } from "./validate";
import type { TechPhones } from "./techphones";

export const SMS_MAX_LEN = 320;
const SMS_TIMEOUT_MS = 3000;

export type SmsMode = "off" | "dry_run" | "live";
export type SmsStatus = "sent" | "dry_run" | "off" | "capped" | "failed";

// The job fields the accept SMS may carry (from the JobActor briefing).
export interface AcceptSmsJob {
  job_id: string;
  urgency: string;
  trade: string;
  suburb: string;
  customer_name?: string;
  address?: string;
  contact_phone?: string;
  details?: string;
  hazards?: string;
}

// Runner deps, injected so tests fake every I/O edge.
export interface AcceptSmsDeps {
  readMode(): Promise<SmsMode>;
  bumpCap(): Promise<boolean>; // false = daily cap reached (or counter failed)
  prefixes: string[];
  send(toE164: string, text: string): Promise<{ ok: boolean; reason?: string }>;
}

// Plain GSM-7 safe subset: printable ASCII only; anything else becomes a
// space and runs of whitespace collapse. No emoji can leave in a text.
const NOT_ASCII = /[^\x20-\x7E]/g;

function gsm(s: string): string {
  return s.replace(NOT_ASCII, " ").replace(/\s+/g, " ").trim();
}

// AU 61 + 9 digits is texted in local form (0412 345 678 without the spaces);
// anything else stays as stored.
function localDigits(digits: string): string {
  return digits.startsWith("61") && digits.length === 11
    ? "0" + digits.slice(2)
    : digits;
}

// Reference, trade and urgency, customer name, callback, address, then
// details/hazards truncated to fit the 320-char cap. Ends "Do not reply."
export function buildAcceptSms(job: AcceptSmsJob): string {
  const TAIL = " Do not reply.";
  const parts: string[] = [
    `${gsm(job.job_id)} ${gsm(job.urgency)} ${gsm(job.trade)} job, ${gsm(job.suburb)}.`,
  ];
  if (typeof job.customer_name === "string" && job.customer_name !== "") {
    parts.push(`Customer ${gsm(job.customer_name).slice(0, 60)}.`);
  }
  if (typeof job.contact_phone === "string" && job.contact_phone !== "") {
    parts.push(`Callback ${localDigits(job.contact_phone)}.`);
  }
  if (typeof job.address === "string" && job.address !== "") {
    parts.push(`Address ${gsm(job.address).slice(0, 120)}.`);
  }
  const extras: string[] = [];
  if (typeof job.details === "string" && job.details !== "") {
    extras.push(`Details: ${gsm(job.details)}`);
  }
  if (typeof job.hazards === "string" && job.hazards !== "") {
    extras.push(`Hazards: ${gsm(job.hazards)}`);
  }
  let body = parts.join(" ");
  for (const extra of extras) {
    if (extra === "") continue;
    const room = SMS_MAX_LEN - (body + TAIL).length - 1; // 1 joining space
    if (room <= 0) break;
    const piece = extra.length > room ? extra.slice(0, room).trimEnd() : extra;
    if (piece === "") break;
    body += " " + piece;
  }
  return body + TAIL;
}

// ---------------------------------------------------------------------------
// Sender: POST https://api.telnyx.com/v2/messages. One attempt, 3 s timeout,
// short reason codes only; the key and the body are never logged.

export type SmsReason =
  | "http_4xx"
  | "http_5xx"
  | "timeout"
  | "network"
  | "no_key"
  | "no_config";

export type SendSms = (
  toE164: string,
  text: string,
) => Promise<{ ok: boolean; reason?: SmsReason }>;

export function makeSmsSender(env: unknown, fetchImpl: typeof fetch = fetch): SendSms {
  const key = readConfig(env, "TELNYX_API_KEY");
  return async (to, text) => {
    if (key === undefined) return { ok: false, reason: "no_key" };
    const profile = readConfig(env, "MESSAGING_PROFILE_ID");
    const from = readConfig(env, "SMS_FROM");
    if (profile === undefined || from === undefined) {
      return { ok: false, reason: "no_config" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);
    try {
      const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to,
          from,
          text,
          messaging_profile_id: profile,
          type: "SMS",
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, reason: res.status >= 500 ? "http_5xx" : "http_4xx" };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// The effect runner: resolve mode, recipient and cap, send, log, report one
// status word. Never throws; the message body never reaches a log line.

export async function runAcceptSms(
  deps: AcceptSmsDeps,
  phones: TechPhones,
  job: AcceptSmsJob | null,
  technicianId: string,
  ctx: { call_ref: string; job_id: string },
): Promise<SmsStatus> {
  let mode: SmsMode = "dry_run"; // fail safe, same pattern as ring_mode
  try {
    mode = await deps.readMode();
  } catch {
    mode = "dry_run";
  }
  const base = {
    component: "ops" as const,
    call_ref: ctx.call_ref,
    job_id: ctx.job_id,
    technician_id: technicianId,
  };
  if (mode === "off") {
    log({ ...base, event: "sms_skipped", error: "off" });
    return "off";
  }
  if (job === null) {
    log({ ...base, event: "sms_skipped", level: "warn", error: "no_job" });
    return "failed";
  }
  const digits = phones.phones[technicianId];
  if (digits === undefined) {
    log({ ...base, event: "sms_skipped", level: "warn", error: "no_phone" });
    return "failed";
  }
  const allow = checkDialAllowed(toE164(digits), deps.prefixes);
  if (!allow.allowed) {
    log({ ...base, event: "sms_skipped", level: "warn", error: allow.reason ?? "prefix" });
    return "failed";
  }
  const body = buildAcceptSms(job);
  if (mode === "dry_run") {
    log({ ...base, event: "sms_dry_run", sms_len: body.length });
    return "dry_run";
  }
  let within = false;
  try {
    within = await deps.bumpCap();
  } catch {
    within = false; // counter failure fails safe: the SMS is skipped
  }
  if (!within) {
    log({ ...base, event: "sms_capped", level: "warn" });
    return "capped";
  }
  try {
    const r = await deps.send(toE164(digits), body);
    if (r.ok === true) {
      log({ ...base, event: "sms_sent", outcome: "ok" });
      return "sent";
    }
    log({ ...base, event: "sms_failed", level: "warn", outcome: "fail", error: r.reason ?? "send_failed" });
    return "failed";
  } catch {
    log({ ...base, event: "sms_failed", level: "warn", outcome: "fail", error: "exception" });
    return "failed";
  }
}
