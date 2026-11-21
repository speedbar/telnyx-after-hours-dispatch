// src/routes/voice.ts
// POST /voice-events — Telnyx Voice App webhook receiver (D20-4b): the leg
// events of the technician ring. Same Ed25519 signature check and fail-closed
// behaviour as /dv — every signature failure gets the SAME 403 body and a
// missing TELNYX_PUBLIC_KEY fails closed. The echoed per-leg client_state
// routes the event to the per-call JobActor; runRing executes the reducer
// effects. Stale, duplicate, unknown or state-less events are answered 200
// (Telnyx retries only 5xx/408/429); 500 is reserved for an unexpected
// exception. Never logs from/to, client_state, the raw body or any payload
// value beyond the short enum-like fields (status, hangup_cause,
// hangup_source, digits).

import { readConfig } from "../lib/config";
import { log, newRequestId, type LogFields } from "../lib/log";
import { verifyTelnyx } from "../lib/sig";
import {
  decodeClientState,
  makeDialer,
  makeTelnyxClient,
  type ClientState,
} from "../lib/telnyx-api";
import { loadTechPhones } from "../lib/techphones";
import { parseAllowedPrefixes, withDialGate, type RingEvent } from "../lib/ring";
import { makeSmsSender, type AcceptSmsDeps, type SmsMode } from "../lib/sms";
import {
  runRing,
  type RingJobs,
  type RingTech,
  type RunRingDeps,
} from "../lib/ringrun";

// Local structural types for the actor stubs (same pattern as routes/tech.ts;
// the generated Env is stale, so the route declares the bindings it needs).
export interface VoiceEnv {
  JOBS?: { idFromName(name: string): RingJobs };
  TECH?: { idFromName(name: string): RingTech };
  [key: string]: unknown;
}

// D20b-1 accept-SMS deps: the sms_mode flag and daily counter live in the
// DirectoryActor (same pattern as ring_mode / the ring cap). Missing binding
// fails safe: dry_run mode reads, and the cap blocks the live send.
interface SmsDirectory {
  flag(name: string): Promise<string | null>;
  bumpCounter(name: string, cap: number): Promise<{ ok: boolean; count: number }>;
}

function buildAcceptSmsDeps(env: VoiceEnv): AcceptSmsDeps {
  const dir = (
    env as { DIRECTORY?: { idFromName(name: string): SmsDirectory } }
  ).DIRECTORY?.idFromName("directory");
  return {
    readMode: async (): Promise<SmsMode> => {
      try {
        const v = dir === undefined ? null : await dir.flag("sms_mode");
        if (v === "off") return "off";
        if (v === "live") return "live";
        return "dry_run"; // missing key or any other value, as specified
      } catch {
        return "dry_run";
      }
    },
    bumpCap: async () => {
      if (dir === undefined) return false;
      const cap = intSetting(readConfig(env, "SMS_DAILY_CAP"), 20, 1, 1000);
      return (await dir.bumpCounter("sms", cap)).ok;
    },
    prefixes: parseAllowedPrefixes(readConfig(env, "ALLOWED_DIAL_PREFIXES")),
    send: makeSmsSender(env),
  };
}

// Deps factory so tests inject fakes; production uses buildRingDeps.
export type RingDepsFactory = (env: VoiceEnv, callActor: string) => RunRingDeps;

// Bounded integer setting: the default when unset or not an integer in range.
function intSetting(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

// Runner deps from env (spec 1.8). jobs is pinned to the call actor `c`;
// every other dep is call-independent. Missing bindings fail as data inside
// runRing, never as a throw at build time.
export function buildRingDeps(env: VoiceEnv, c: string): RunRingDeps {
  const jobsBinding = env.JOBS;
  const techBinding = env.TECH;
  const missingJobs: RingJobs = {
    ringEvent: () => Promise.reject(new Error("jobs_unavailable")),
    get: () => Promise.reject(new Error("jobs_unavailable")),
  };
  return {
    jobs: jobsBinding === undefined ? missingJobs : jobsBinding.idFromName(c),
    tech: (id: string): RingTech => {
      if (techBinding === undefined) throw new Error("tech_unavailable");
      return techBinding.idFromName(id);
    },
    client: makeTelnyxClient(env),
    dialer: withDialGate(readConfig(env, "ALLOWED_DIAL_PREFIXES"), makeDialer(env)),
    phones: loadTechPhones(readConfig(env, "TECH_PHONES_JSON")),
    // D20b-2: optional TTS voice id; unset/empty = no voice key in the body.
    voice: readConfig(env, "RING_VOICE"),
    language: readConfig(env, "RING_TTS_LANGUAGE") ?? "en-US",
    holdTtlS: intSetting(readConfig(env, "RING_HOLD_TTL_S"), 60, 1, 600),
    busyS: intSetting(readConfig(env, "DISPATCH_BUSY_S"), 1800, 1, 86400),
    sms: buildAcceptSmsDeps(env),
  };
}

// A short enum-like string (safe to log) or undefined.
function shortEnum(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

const ok200 = (): Response => Response.json({ ok: true }, { status: 200 });

// One voice_event line per handled event: the event type, the payload KEY
// NAMES (capped) and the few enum-like values — nothing else from the
// payload. This is how we learn the real webhook shape (docs/verify-log.md).
function logVoiceEvent(
  requestId: string,
  state: ClientState,
  eventType: string,
  payload: Record<string, unknown> | undefined,
): void {
  const fields: LogFields = {
    component: "events",
    event: "voice_event",
    request_id: requestId,
    call_ref: state.c,
    job_id: state.j,
    technician_id: state.t,
    attempt: state.a,
    node: eventType.length > 80 ? eventType.slice(0, 80) : eventType,
  };
  if (payload !== undefined) {
    fields.meta_keys = Object.keys(payload).join(",").slice(0, 200);
    const status = shortEnum(payload.status, 40);
    if (status !== undefined) fields.payload_status = status;
    const cause = shortEnum(payload.hangup_cause, 40);
    if (cause !== undefined) fields.hangup_cause = cause;
    const source = shortEnum(payload.hangup_source, 40);
    if (source !== undefined) fields.hangup_source = source;
    const digits = payload.digits;
    if (typeof digits === "string" && digits.length <= 3) fields.digits = digits;
  }
  log(fields);
}

// Object or {} for safe property reads — never an array or a scalar.
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export async function handleVoiceEvents(
  request: Request,
  env: VoiceEnv,
  nowMs: number = Date.now(),
  depsFor: RingDepsFactory = buildRingDeps,
): Promise<Response> {
  const request_id = newRequestId();

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  const rawBody = await request.text(); // read once
  const publicKey = readConfig(env, "TELNYX_PUBLIC_KEY");
  if (publicKey === undefined) {
    log({
      component: "events",
      event: "voice_sig_fail",
      level: "error",
      request_id,
      outcome: "rejected",
      error: "no_public_key",
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const result = await verifyTelnyx(
    rawBody,
    request.headers.get("telnyx-signature-ed25519"),
    request.headers.get("telnyx-timestamp"),
    publicKey,
    nowMs,
  );
  if (!result.ok) {
    // Same body for every reason: the caller learns nothing.
    log({
      component: "events",
      event: "voice_sig_fail",
      level: "warn",
      request_id,
      outcome: "rejected",
      error: result.reason,
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Signed but not JSON: a 4xx is not retried (spec section 6).
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const d = asRecord(asRecord(parsed).data);
  const rawPayload = d.payload;
  const payload =
    rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : undefined;
  const p = payload ?? {};
  const eventType = shortEnum(d.event_type, 256);
  const eventId = shortEnum(d.id, 256);
  const ccid = shortEnum(p.call_control_id, 256);

  const state = decodeClientState(p.client_state);
  if (state === null) {
    log({
      component: "events",
      event: "voice_event_no_state",
      level: "warn",
      request_id,
      ...(eventType !== undefined ? { node: eventType.slice(0, 80) } : {}),
    });
    return ok200();
  }

  try {
    const deps = depsFor(env, state.c);
    switch (eventType) {
      case "call.answered":
      case "call.gather.ended":
      case "call.hangup": {
        if (eventId === undefined || ccid === undefined) {
          log({
            component: "events",
            event: "voice_event_ignored",
            request_id,
            node: eventType,
          });
          return ok200();
        }
        logVoiceEvent(request_id, state, eventType, payload);
        let ev: RingEvent;
        if (eventType === "call.answered") {
          ev = { type: "answered", call_control_id: ccid, event_id: eventId, now: nowMs };
        } else if (eventType === "call.gather.ended") {
          ev = {
            type: "gather",
            call_control_id: ccid,
            digits: typeof p.digits === "string" ? p.digits : "",
            event_id: eventId,
            now: nowMs,
          };
        } else {
          ev = { type: "hangup", call_control_id: ccid, event_id: eventId, now: nowMs };
        }
        await runRing(deps, state.c, ev);
        return ok200();
      }

      case "call.speak.ended": {
        logVoiceEvent(request_id, state, eventType, payload);
        // A confirmation finished (accept: status accepted; decline: the leg
        // stamped in confirm_ccid — D20b-2): hang that leg up once. Every
        // other speak.ended is ignored.
        if (ccid !== undefined) {
          const job = await deps.jobs.get();
          if (job?.ring?.status === "accepted" || job?.ring?.confirm_ccid === ccid) {
            const r = await deps.client.hangup(ccid);
            if (!r.ok) {
              log({
                component: "events",
                event: "voice_hangup_fail",
                level: "warn",
                request_id,
                call_ref: state.c,
                job_id: state.j,
                error: r.reason ?? "hangup_failed",
              });
            }
          }
        }
        return ok200();
      }

      default:
        log({
          component: "events",
          event: "voice_event_ignored",
          request_id,
          ...(eventType !== undefined ? { node: eventType.slice(0, 80) } : {}),
        });
        return ok200();
    }
  } catch (err) {
    // Unexpected: 500 so Telnyx retries; short error name only — a raw error
    // may embed ids or numbers.
    log({
      component: "events",
      event: "voice_event_fail",
      level: "error",
      request_id,
      call_ref: state.c,
      job_id: state.j,
      error: err instanceof Error ? err.name : "unknown",
    });
    return Response.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
