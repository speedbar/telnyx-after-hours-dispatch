// src/routes/dv.ts
// POST /dv — Telnyx dynamic-variables webhook, called when a call starts
// (assistant.initialization). Signature-verified. Hot state (feature flag,
// customer record) is read with ONE call to the DirectoryActor (D13, BUG-003:
// actor storage ~0.1 s per op, KV ~1.5-1.9 s — two KV gets blew the 1.5 s
// webhook timeout). KV stays the durable copy, written off the hot path by
// /admin/seed. Any internal failure still returns 200 with SAFE DEFAULTS so
// the call always proceeds. Never logs the body, the phone number, the
// signature or any secret — only the salted caller_hash.

import { readConfig } from "../lib/config";
import { callerHash, log, newRequestId, timed } from "../lib/log";
import { verifyTelnyx } from "../lib/sig";
import { spoken } from "../lib/validate";

const BUSINESS_NAME = "Harbour Trades After-Hours";

// Spoken escalation number: digits of the FALLBACK_NUMBER secret, spoken one
// character at a time. Unset (or no digits) degrades to "the office" + a warn.
function fallbackSpoken(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits === "" ? null : spoken(digits);
}

// 12 random lowercase hex chars for a degraded call_ref ("u:" + hex), so two
// degraded calls never share a reservation.
function randomRef(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return "u:" + hex;
}

// The lookup may never take longer than this; Telnyx's webhook timeout is
// 1.5 s and we still need time to hash and respond.
const LOOKUP_TIMEOUT_MS = 1000;

// Raw result of a DirectoryActor.lookup call (raw strings, no parsing).
export interface LookupResult {
  flag: string | null;
  customer: string | null;
}

// Local structural type for the DIRECTORY actor stub. telnyx-env.d.ts is
// generated and only knows the bindings from the last `telnyx-edge types`
// run, which the human runs; until then Env has no DIRECTORY member, so the
// route types the stub itself (and marks it optional — see DvEnv).
export interface DirectoryStub {
  lookup(phoneDigits: string, flagName: string): Promise<LookupResult>;
}

export interface DvEnv {
  // Optional in the TYPE only so `{ ...env }` in src/index.ts compiles before
  // the generated Env is regenerated; the binding exists at runtime. A
  // missing binding degrades safely (see below).
  DIRECTORY?: { idFromName(name: string): DirectoryStub };
  [key: string]: unknown;
}

// Expected shape of the cust/<digits> record.
interface CustomerRecord {
  customer_id?: unknown;
  name?: unknown;
  address?: unknown;
  site_notes?: unknown;
  after_hours_contract?: unknown;
}

// dv_degraded error names: the timeout race rejects with a sentinel message
// that must surface as exactly "lookup_timeout"; every other failure is
// "lookup_failed:" + the constructor name (never the message — a raw error
// may embed the key, and the key contains phone digits).
function lookupErrorName(err: unknown): string {
  if (err instanceof Error && err.message === "lookup_timeout") {
    return "lookup_timeout";
  }
  return "lookup_failed:" + (err instanceof Error ? err.name : "unknown");
}

// Race the actor call against a hard timeout so a slow or stuck actor can
// never blow Telnyx's webhook budget. The timer is always cleared; the losing
// promise's settlement stays handled by Promise.race.
async function raceLookup(
  stub: DirectoryStub,
  phoneDigits: string,
  timeoutMs: number,
): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stub.lookup(phoneDigits, "dispatch_enabled"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("lookup_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleDv(
  request: Request,
  env: DvEnv,
  nowMs: number = Date.now(),
  lookupTimeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<Response> {
  const request_id = newRequestId();
  const startedAt = performance.now();
  const latencyMs = (): number => Math.max(0, Math.round(performance.now() - startedAt));

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  const rawBody = await request.text(); // read once
  // conv_hash (S1.9 item 5d): salted hash of the Telnyx conversation id in the
  // payload, same salt and method as caller_hash, null when there is no id.
  // Computed before the signature check so every /dv line can be correlated;
  // the raw id is never logged. A non-JSON body degrades later as before.
  let conv_hash: string | undefined;
  try {
    const p = (JSON.parse(rawBody) as { data?: { payload?: Record<string, unknown> } | undefined })
      ?.data?.payload;
    const convId = p?.telnyx_conversation_id;
    const salt = readConfig(env, "LOG_SALT");
    if (typeof convId === "string" && convId !== "" && salt !== undefined) {
      conv_hash = await callerHash(convId, salt);
    }
  } catch {
    // Not JSON (or an odd shape): the main flow turns this into dv_degraded.
  }
  log({ component: "dv", event: "dv_in", request_id, conv_hash });

  const publicKey = readConfig(env, "TELNYX_PUBLIC_KEY");
  if (publicKey === undefined) {
    log({
      component: "dv",
      event: "sig_fail",
      level: "error",
      request_id,
      conv_hash,
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
      component: "dv",
      event: "sig_fail",
      level: "warn",
      request_id,
      conv_hash,
      outcome: "rejected",
      error: result.reason,
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const hold_ttl_s = readConfig(env, "DISPATCH_HOLD_TTL_S") ?? "90";
  const fallback_number_spoken =
    fallbackSpoken(readConfig(env, "FALLBACK_NUMBER")) ?? "the office";
  if (fallback_number_spoken === "the office") {
    log({
      component: "dv",
      event: "fallback_number_unset",
      level: "warn",
      request_id,
      conv_hash,
    });
  }
  let call_ref = randomRef();
  let caller_hash: string | undefined;

  try {
    const parsed: unknown = JSON.parse(rawBody);
    const payload = (parsed as { data?: { payload?: Record<string, unknown> } })
      ?.data?.payload;
    const phone =
      payload !== undefined &&
      payload !== null &&
      typeof payload.telnyx_end_user_target === "string"
        ? payload.telnyx_end_user_target
        : undefined;
    if (
      payload !== undefined &&
      payload !== null &&
      typeof payload.call_control_id === "string"
    ) {
      call_ref = payload.call_control_id;
    }

    const salt = readConfig(env, "LOG_SALT");
    if (phone !== undefined && salt !== undefined) {
      caller_hash = await callerHash(phone, salt);
    }

    // ONE directory call for the flag and the customer (KV is off the hot
    // path, D13). With no phone there is still a lookup — phoneDigits "0" is
    // an empty-safe stand-in (cust/0 never exists) so the flag still resolves.
    const phoneDigits = phone !== undefined ? phone.replace(/\+/g, "") : "0";
    const stub = env.DIRECTORY?.idFromName("directory");
    if (stub === undefined) {
      throw new Error("directory_unavailable");
    }
    const lookupStartedAt = performance.now();
    let flag: string | null;
    let customer: string | null;
    try {
      const lookup = await timed(() =>
        raceLookup(stub, phoneDigits, lookupTimeoutMs),
      );
      flag = lookup.result.flag;
      customer = lookup.result.customer;
      log({
        component: "dv",
        event: "dv_lookup",
        request_id,
        call_ref,
        caller_hash,
        conv_hash,
        tool: "actor.lookup",
        outcome: "ok",
        latency_ms: lookup.latency_ms,
      });
    } catch (err) {
      log({
        component: "dv",
        event: "dv_lookup",
        level: "warn",
        request_id,
        call_ref,
        caller_hash,
        conv_hash,
        tool: "actor.lookup",
        outcome: "fail",
        latency_ms: Math.max(0, Math.round(performance.now() - lookupStartedAt)),
        error: lookupErrorName(err),
      });
      throw err;
    }

    const dispatch_enabled = flag === "false" ? "false" : "true";

    let record: CustomerRecord | undefined;
    if (typeof customer === "string") {
      try {
        const parsedRecord: unknown = JSON.parse(customer);
        if (parsedRecord !== null && typeof parsedRecord === "object") {
          record = parsedRecord as CustomerRecord;
        }
      } catch {
        log({
          component: "dv",
          event: "dv_bad_customer_record",
          level: "warn",
          request_id,
          call_ref,
          caller_hash,
          conv_hash,
        });
      }
    }

    const variables: Record<string, string> = {
      call_ref,
      business_name: BUSINESS_NAME,
      caller_known: record !== undefined ? "true" : "false",
      customer_name: typeof record?.name === "string" ? record.name : "",
      customer_address: typeof record?.address === "string" ? record.address : "",
      dispatch_enabled,
      fallback_number_spoken,
      hold_ttl_s,
    };

    log({
      component: "dv",
      event: "dv_out",
      request_id,
      call_ref,
      caller_hash,
      conv_hash,
      outcome: "ok",
      latency_ms: latencyMs(),
    });
    return Response.json({ dynamic_variables: variables }, { status: 200 });
  } catch (err) {
    // Lookup error, timeout or bad JSON: answer with SAFE DEFAULTS so the
    // call proceeds. Short error name only — a raw error may embed phone
    // digits.
    log({
      component: "dv",
      event: "dv_degraded",
      level: "warn",
      request_id,
      call_ref,
      caller_hash,
      conv_hash,
      outcome: "degraded",
      error: lookupErrorName(err),
    });
    const defaults: Record<string, string> = {
      call_ref,
      business_name: BUSINESS_NAME,
      caller_known: "false",
      customer_name: "",
      customer_address: "",
      dispatch_enabled: "true",
      fallback_number_spoken,
      hold_ttl_s,
    };
    log({
      component: "dv",
      event: "dv_out",
      request_id,
      call_ref,
      caller_hash,
      conv_hash,
      outcome: "degraded",
      latency_ms: latencyMs(),
    });
    return Response.json({ dynamic_variables: defaults }, { status: 200 });
  }
}
