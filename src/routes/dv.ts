// src/routes/dv.ts
// POST /dv — Telnyx dynamic-variables webhook, called when a call starts
// (assistant.initialization). Signature-verified, KV reads only (fast, no
// external calls). Any internal failure still returns 200 with SAFE DEFAULTS
// so the call always proceeds. Never logs the body, the phone number, the
// signature or any secret — only the salted caller_hash.

import { readConfig } from "../lib/config";
import { keys } from "../lib/kv-keys";
import { callerHash, log, newRequestId } from "../lib/log";
import { verifyTelnyx } from "../lib/sig";

const BUSINESS_NAME = "Harbour Trades After-Hours";
// TODO: replace with the real human escalation number, spoken in digit groups.
const FALLBACK_NUMBER_SPOKEN = "zero four nine one, five seven zero, one five six";

// The KV part matches the real binding's get(key) form (KvNamespace in
// @telnyx/edge-runtime), so src/index.ts can pass its real env.
export interface DvEnv {
  DISPATCH_KV: { get(key: string): Promise<string | null> };
  [key: string]: unknown;
}

// Expected shape of the cust/<digits> KV record.
interface CustomerRecord {
  customer_id?: unknown;
  name?: unknown;
  address?: unknown;
  site_notes?: unknown;
  after_hours_contract?: unknown;
}

export async function handleDv(
  request: Request,
  env: DvEnv,
  nowMs: number = Date.now(),
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
  log({ component: "dv", event: "dv_in", request_id });

  const publicKey = readConfig(env, "TELNYX_PUBLIC_KEY");
  if (publicKey === undefined) {
    log({
      component: "dv",
      event: "sig_fail",
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
      component: "dv",
      event: "sig_fail",
      level: "warn",
      request_id,
      outcome: "rejected",
      error: result.reason,
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const hold_ttl_s = readConfig(env, "DISPATCH_HOLD_TTL_S") ?? "90";
  let call_ref = "unknown";
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

    const flagValue = await env.DISPATCH_KV.get(keys.flag("dispatch_enabled"));
    const dispatch_enabled = flagValue === "false" ? "false" : "true";

    let record: CustomerRecord | undefined;
    if (phone !== undefined) {
      const raw = await env.DISPATCH_KV.get(keys.customer(phone));
      if (typeof raw === "string") {
        try {
          const parsedRecord: unknown = JSON.parse(raw);
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
          });
        }
      }
    }

    const variables: Record<string, string> = {
      call_ref,
      business_name: BUSINESS_NAME,
      caller_known: record !== undefined ? "true" : "false",
      customer_name: typeof record?.name === "string" ? record.name : "",
      customer_address: typeof record?.address === "string" ? record.address : "",
      dispatch_enabled,
      fallback_number_spoken: FALLBACK_NUMBER_SPOKEN,
      hold_ttl_s,
    };

    log({
      component: "dv",
      event: "dv_out",
      request_id,
      call_ref,
      caller_hash,
      outcome: "ok",
      latency_ms: latencyMs(),
    });
    return Response.json({ dynamic_variables: variables }, { status: 200 });
  } catch (err) {
    // KV error or bad JSON: answer with SAFE DEFAULTS so the call proceeds.
    // Short message only — a raw error may embed the KV key (phone digits).
    log({
      component: "dv",
      event: "dv_degraded",
      level: "warn",
      request_id,
      call_ref,
      caller_hash,
      outcome: "degraded",
      error: "lookup_failed:" + (err instanceof Error ? err.name : "unknown"),
    });
    const defaults: Record<string, string> = {
      call_ref,
      business_name: BUSINESS_NAME,
      caller_known: "false",
      customer_name: "",
      customer_address: "",
      dispatch_enabled: "true",
      fallback_number_spoken: FALLBACK_NUMBER_SPOKEN,
      hold_ttl_s,
    };
    log({
      component: "dv",
      event: "dv_out",
      request_id,
      call_ref,
      caller_hash,
      outcome: "degraded",
      latency_ms: latencyMs(),
    });
    return Response.json({ dynamic_variables: defaults }, { status: 200 });
  }
}
