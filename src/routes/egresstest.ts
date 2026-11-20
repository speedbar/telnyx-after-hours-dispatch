// src/routes/egresstest.ts
// TEMPORARY (removed in D20-3): D20-0 spike route. POST /admin/egress-test
// answers whether outbound fetch to api.telnyx.com works (a) from the edge
// function and (b) from inside an actor method. Both legs GET /v2/balance
// with NO Authorization header and a 3000 ms AbortController timeout; each
// returns {status, ms} or {error: <error name>, ms}. Never sends a
// credential; the response body is never read or logged. Auth mirrors
// /admin/tech: x-admin-token compared in constant time, never logged.

import { readConfig } from "../lib/config";
import { log, newRequestId } from "../lib/log";
import { tokenEqual } from "./seed";

export interface EgressProbeResult {
  status?: number;
  error?: string;
  ms: number;
}

// Local structural type for the DIRECTORY actor stub (same pattern as
// SeedStub in src/routes/seed.ts).
export interface EgressStub {
  probe(): Promise<EgressProbeResult>;
}

export interface EgressTestEnv {
  DIRECTORY?: { idFromName(name: string): EgressStub };
  [key: string]: unknown;
}

// TEMPORARY (removed in D20-3): one egress probe. No Authorization header,
// 3000 ms abort, status or error name only — never the response body.
export async function probeBalance(): Promise<EgressProbeResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch("https://api.telnyx.com/v2/balance", {
      signal: controller.signal,
    });
    return { status: res.status, ms: Date.now() - start };
  } catch (err) {
    return {
      error: err instanceof Error ? err.name : "unknown",
      ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleEgressTest(
  request: Request,
  env: EgressTestEnv,
): Promise<Response> {
  const request_id = newRequestId();

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  const expected = readConfig(env, "ADMIN_TOKEN");
  const provided = request.headers.get("x-admin-token");
  if (expected === undefined || provided === null || !tokenEqual(provided, expected)) {
    log({
      component: "ops",
      event: "egress_fail",
      level: "warn",
      request_id,
      outcome: "rejected",
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const fn = await probeBalance();

  let actor: EgressProbeResult;
  const stub = env.DIRECTORY?.idFromName("directory");
  if (stub === undefined) {
    actor = { error: "directory_unavailable", ms: 0 };
  } else {
    const start = Date.now();
    try {
      actor = await stub.probe();
    } catch (err) {
      actor = {
        error: err instanceof Error ? err.name : "unknown",
        ms: Date.now() - start,
      };
    }
  }

  // Counts/timings embedded in the event string (seed_done style) because
  // LogFields has no probe fields; statuses only, never bodies.
  log({
    component: "ops",
    event: `egress_test fn=${fn.status ?? fn.error} fn_ms=${fn.ms} actor=${actor.status ?? actor.error} actor_ms=${actor.ms}`,
    request_id,
    outcome: "ok",
    latency_ms: Math.max(fn.ms, actor.ms),
  });
  return Response.json({ ok: true, function: fn, actor }, { status: 200 });
}
