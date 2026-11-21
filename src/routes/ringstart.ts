// src/routes/ringstart.ts
// POST /ring-start — D20-5e: the JobActor alarm keeps the ring timing but
// does not appear to see the function's ring secrets (V-020), so it POSTs
// here with {call_ref, token}. The token is single-use (stored on the job at
// create_job, consumed inside the actor); the FUNCTION, which has the
// secrets, runs startRing and returns {ok:true, reason} for the alarm to
// stamp on the job. Every token failure — wrong, replayed, or a ring already
// started — gets the SAME 403 body with no detail. Never logs the token;
// never throws; 500 only on an unexpected exception.

import { log, newRequestId } from "../lib/log";
import { startRing, type RingStartReason, type StartRingEnv } from "../lib/ringstart";
import type { RingJobs } from "../lib/ringrun";

// The JobActor stub: the ring path (RingJobs) plus the single-use token check.
export interface RingStartJobs extends RingJobs {
  consumeRingToken(token: string): Promise<boolean>;
}

export interface RingStartRouteEnv extends StartRingEnv {
  JOBS?: { idFromName(name: string): RingStartJobs };
}

// Injectable for tests (same pattern as StartRingFn in routes/ringtest.ts).
export type RingStartFn = (
  env: StartRingEnv,
  callActor: string,
) => Promise<{ reason: RingStartReason }>;

interface RingStartBody {
  call_ref: string;
  token: string;
}

// Shape-check { call_ref, token }; never throws.
function parseBody(raw: unknown): RingStartBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.call_ref !== "string" || b.call_ref === "") return null;
  if (typeof b.token !== "string" || b.token === "") return null;
  return { call_ref: b.call_ref, token: b.token };
}

export async function handleRingStart(
  request: Request,
  env: RingStartRouteEnv,
  startFn: RingStartFn = startRing,
): Promise<Response> {
  const request_id = newRequestId();

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const body = parseBody(raw);
  if (body === null) {
    return Response.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  // One try block: a missing binding or a throwing actor both land in 500.
  try {
    const binding = env.JOBS;
    if (binding === undefined) {
      throw new Error("jobs_binding_missing");
    }
    const ok = await binding.idFromName(body.call_ref).consumeRingToken(body.token);
    if (!ok) {
      log({
        component: "ops",
        event: "ring_cb_fail",
        level: "warn",
        request_id,
        call_ref: body.call_ref,
        outcome: "rejected",
        error: "forbidden",
      });
      return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    const r = await startFn(env, body.call_ref);
    return Response.json({ ok: true, reason: r.reason }, { status: 200 });
  } catch (err) {
    log({
      component: "ops",
      event: "ring_cb_fail",
      level: "error",
      request_id,
      call_ref: body.call_ref,
      outcome: "fail",
      error: err instanceof Error ? err.name : "unknown",
    });
    return Response.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
