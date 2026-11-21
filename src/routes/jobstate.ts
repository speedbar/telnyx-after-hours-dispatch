// src/routes/jobstate.ts
// POST /admin/job-state — guarded admin route that reads one JobActor record
// by call_ref and returns its state and ring snapshot for ops checks (actor
// log lines are not visible in telnyx-edge logs, so this is the state-based
// check). Auth mirrors /admin/tech exactly: x-admin-token compared in
// constant time, fail closed when ADMIN_TOKEN is unset, 403 before any actor
// is touched. Never returns phone numbers, names, addresses, summary or the
// brief: only technician ids, ring progress and timestamps.

import { readConfig } from "../lib/config";
import { log, newRequestId } from "../lib/log";
import { resolveCallRef } from "../lib/validate";
import { tokenEqual } from "./seed";

// Local structural type for the JOBS actor stub (same pattern as TechStub).
export interface JobStateStub {
  get(): Promise<JobStateRecord | null>;
}

// The fields this route may read; anything else on the record is not touched.
interface JobStateRecord {
  job_id: string;
  state: string;
  dispatch_state?: string;
  ring?: {
    status: string;
    attempt: number;
    tried: string[];
    outcome_log: Array<{ technician_id: string; outcome: string; at: number }>;
  };
  ring_at?: number;
  retention_at?: number;
  ring_alarm_ran_at?: number;
  ring_start_reason?: string;
}

export interface JobStateEnv {
  JOBS?: { idFromName(name: string): JobStateStub };
  [key: string]: unknown;
}

interface JobStateBody {
  call_ref: string;
}

// Shape-check { call_ref }; never throws.
function parseBody(raw: unknown): JobStateBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.call_ref !== "string" || body.call_ref === "") {
    return null;
  }
  return { call_ref: body.call_ref };
}

export async function handleJobState(
  request: Request,
  env: JobStateEnv,
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
      event: "job_state_fail",
      level: "warn",
      request_id,
      outcome: "rejected",
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
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

  // Same actor-name resolution create_job uses for an explicit args.call_ref.
  const resolved = await resolveCallRef({ call_ref: body.call_ref }, undefined);
  if (resolved.ref === null) {
    return Response.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  // One try block: a missing JOBS binding or a throwing actor both land here.
  try {
    const binding = env.JOBS;
    if (binding === undefined) {
      throw new Error("jobs_binding_missing");
    }
    const rec = await binding.idFromName(resolved.ref).get();
    if (rec === null) {
      return Response.json({ ok: true, found: false }, { status: 200 });
    }
    const ring = rec.ring;
    const now = Date.now();
    return Response.json(
      {
        ok: true,
        found: true,
        job_id: rec.job_id,
        state: rec.state,
        dispatch_state: rec.dispatch_state,
        ring_status: ring?.status,
        ring_attempt: ring?.attempt,
        ring_tried: ring?.tried,
        ring_outcomes: ring?.outcome_log.map((o) => ({
          technician_id: o.technician_id,
          outcome: o.outcome,
          at: o.at,
        })),
        ring_at_pending: rec.ring_at !== undefined,
        ring_at_overdue: rec.ring_at !== undefined && rec.ring_at <= now,
        retention_at: rec.retention_at,
        ring_alarm_ran_at: rec.ring_alarm_ran_at,
        ring_start_reason: rec.ring_start_reason,
      },
      { status: 200 },
    );
  } catch (err) {
    log({
      component: "ops",
      event: "job_state_fail",
      level: "error",
      request_id,
      outcome: "fail",
      error: err instanceof Error ? err.name : "unknown",
    });
    return Response.json({ ok: false, error: "actor_failed" }, { status: 500 });
  }
}
