// src/lib/telnyx-api.ts
// Telnyx v2 API client (D20-3): dial / gather_using_speak / speak / hangup
// over an injected fetch (default global). Errors as data, never throws.
// 3000 ms AbortController timeout on every call. Authorization Bearer comes
// from readConfig(env, "TELNYX_API_KEY"). Logs only the reason code and the
// first Telnyx error code — never a response body, a header, the key, a
// phone number or the brief text.

import { readConfig } from "./config";
import { log } from "./log";
import { toE164 } from "./validate";
import type { Dialer, DialResult } from "./ring";

const API_BASE = "https://api.telnyx.com/v2";
const TIMEOUT_MS = 3000;

export type FetchLike = typeof fetch;

// Short failure codes; reason is data, never an exception.
export type ApiReason =
  | "http_4xx"
  | "http_5xx"
  | "timeout"
  | "network"
  | "no_key"
  | "no_config"
  | "bad_response";

export interface CommandResult {
  ok: boolean;
  reason?: ApiReason;
}

export interface DialOptions {
  connection_id: string;
  to: string; // E.164
  from: string; // E.164
  client_state?: string;
  timeout_secs?: number;
  time_limit_secs?: number;
  command_id?: string;
}

export interface GatherOptions {
  payload: string;
  voice: string;
  language: string;
  timeout_millis?: number; // default 8000
  client_state?: string;
  command_id?: string;
}

export interface SpeakOptions {
  payload: string;
  voice: string;
  language: string;
  client_state?: string;
  command_id?: string;
}

export interface TelnyxClient {
  dial(opts: DialOptions): Promise<DialResult>;
  gatherUsingSpeak(callControlId: string, opts: GatherOptions): Promise<CommandResult>;
  speak(callControlId: string, opts: SpeakOptions): Promise<CommandResult>;
  hangup(callControlId: string): Promise<CommandResult>;
}

// Log a Telnyx-side failure: reason class and first error code only.
function logFail(reason: ApiReason, code?: string): void {
  log({
    component: "ops",
    event: "telnyx_api_fail",
    level: "warn",
    outcome: "fail",
    error: code === undefined ? reason : reason + " " + code,
  });
}

// First error code from a Telnyx error body ({errors:[{code,...}]}), or
// undefined. The code is logged; the body itself never is.
async function firstErrorCode(res: Response): Promise<string | undefined> {
  try {
    const data: unknown = await res.json();
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const errors = (data as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0] as { code?: unknown };
        if (typeof first.code === "string" || typeof first.code === "number") {
          return String(first.code);
        }
      }
    }
  } catch {
    // Non-JSON error body: nothing safe to extract.
  }
  return undefined;
}

async function callApi(
  key: string,
  fetchImpl: FetchLike,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: ApiReason }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(API_BASE + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const reason: ApiReason = res.status >= 500 ? "http_5xx" : "http_4xx";
      const code = await firstErrorCode(res);
      logFail(reason, code);
      return { ok: false, reason };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null; // action endpoints may answer with an empty body
    }
    return { ok: true, json };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logFail("timeout");
      return { ok: false, reason: "timeout" };
    }
    logFail("network");
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function makeTelnyxClient(env: unknown, fetchImpl: FetchLike = fetch): TelnyxClient {
  const key = readConfig(env, "TELNYX_API_KEY");
  const noKey = (): { ok: false; reason: ApiReason } => {
    logFail("no_key");
    return { ok: false, reason: "no_key" };
  };
  return {
    async dial(opts) {
      if (key === undefined) return noKey();
      const body: Record<string, unknown> = { connection_id: opts.connection_id, to: opts.to, from: opts.from };
      if (opts.client_state !== undefined) body.client_state = opts.client_state;
      if (opts.timeout_secs !== undefined) body.timeout_secs = opts.timeout_secs;
      if (opts.time_limit_secs !== undefined) body.time_limit_secs = opts.time_limit_secs;
      if (opts.command_id !== undefined) body.command_id = opts.command_id;
      const r = await callApi(key, fetchImpl, "/calls", body);
      if (!r.ok) return { ok: false, reason: r.reason };
      const ccid = (r.json as { data?: { call_control_id?: unknown } } | null)?.data?.call_control_id;
      if (typeof ccid !== "string" || ccid === "") {
        logFail("bad_response");
        return { ok: false, reason: "bad_response" };
      }
      return { ok: true, call_control_id: ccid };
    },

    async gatherUsingSpeak(callControlId, opts) {
      if (key === undefined) return noKey();
      const body: Record<string, unknown> = {
        payload: opts.payload,
        voice: opts.voice,
        language: opts.language,
        minimum_digits: 1,
        maximum_digits: 1,
        valid_digits: "12",
        timeout_millis: opts.timeout_millis ?? 8000,
        maximum_tries: 1,
      };
      if (opts.client_state !== undefined) body.client_state = opts.client_state;
      if (opts.command_id !== undefined) body.command_id = opts.command_id;
      const r = await callApi(key, fetchImpl, "/calls/" + callControlId + "/actions/gather_using_speak", body);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },

    async speak(callControlId, opts) {
      if (key === undefined) return noKey();
      const body: Record<string, unknown> = { payload: opts.payload, voice: opts.voice, language: opts.language };
      if (opts.client_state !== undefined) body.client_state = opts.client_state;
      if (opts.command_id !== undefined) body.command_id = opts.command_id;
      const r = await callApi(key, fetchImpl, "/calls/" + callControlId + "/actions/speak", body);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },

    async hangup(callControlId) {
      if (key === undefined) return noKey();
      const r = await callApi(key, fetchImpl, "/calls/" + callControlId + "/actions/hangup");
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
  };
}

// D20-2's Dialer shape for the ring harness: digits in, {ok, call_control_id}
// out. NOT wrapped in withDialGate here — the caller composes the gate.
export function makeDialer(env: unknown, fetchImpl: FetchLike = fetch): Dialer {
  const client = makeTelnyxClient(env, fetchImpl);
  return async (toDigits, opts) => {
    const connectionId = readConfig(env, "VOICE_CONNECTION_ID");
    const fromRaw = readConfig(env, "DISPATCH_FROM_NUMBER");
    if (connectionId === undefined || fromRaw === undefined) {
      logFail("no_config");
      return { ok: false, reason: "no_config" };
    }
    const from = fromRaw.startsWith("+") ? fromRaw : toE164(fromRaw);
    return await client.dial({
      connection_id: connectionId,
      to: toE164(toDigits),
      from,
      timeout_secs: 25,
      time_limit_secs: 120,
      ...(opts?.client_state !== undefined ? { client_state: opts.client_state } : {}),
      ...(opts?.command_id !== undefined ? { command_id: opts.command_id } : {}),
    });
  };
}

// ---------------------------------------------------------------------------
// client_state codec (spec 1.3): base64 of a small JSON the Voice App echoes
// back on every webhook for the leg. c = call actor name, j = job_id,
// t = technician_id, a = attempt. decode never throws: null on any bad input.

export interface ClientState {
  c: string;
  j: string;
  t: string;
  a: number;
}

export function encodeClientState(state: ClientState): string {
  return btoa(JSON.stringify({ c: state.c, j: state.j, t: state.t, a: state.a }));
}

export function decodeClientState(raw: unknown): ClientState | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(atob(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.c !== "string" || typeof o.j !== "string" || typeof o.t !== "string") return null;
    if (typeof o.a !== "number" || !Number.isInteger(o.a)) return null;
    return { c: o.c, j: o.j, t: o.t, a: o.a };
  } catch {
    return null;
  }
}
