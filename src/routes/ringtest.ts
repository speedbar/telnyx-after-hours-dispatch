// src/routes/ringtest.ts
// POST /admin/ring-test — guarded admin route that rings a named technician
// with a fully fake job ("sim-" call_ref, fake suburb/summary, no real data),
// so the first live ring test needs no phone call to the assistant (spec 1.9).
// Auth mirrors /admin/tech exactly: x-admin-token compared in constant time,
// fail closed when ADMIN_TOKEN is unset, and 403 before any actor is touched.
// mode defaults to "dry_run" and can never be "off": this route always passes
// an explicit mode override to startRing, so an "off" flag cannot silence a
// deliberate test and nothing dials unless mode:"live" is in the body.

import { readConfig } from "../lib/config";
import { log, newRequestId } from "../lib/log";
import { tokenEqual } from "./seed";
import {
  startRing,
  type StartRingEnv,
  type StartRingOpts,
} from "../lib/ringstart";
import type { RingJobs, RingTech } from "../lib/ringrun";

const TRADES = ["plumbing", "electrical", "gas", "hvac", "other"] as const;
type RingTestMode = "dry_run" | "live";

// The JobActor stub with the create path this route reuses (open + get).
export interface RingTestJobs extends RingJobs {
  open(args: {
    job_id: string;
    tech_id: string;
    urgency: string;
    trade: string;
    suburb: string;
    summary: string;
  }): Promise<{ ok: boolean }>;
}

export interface RingTestEnv extends StartRingEnv {
  JOBS?: { idFromName(name: string): RingTestJobs };
  TECH?: { idFromName(name: string): RingTech };
}

export type StartRingFn = (
  env: StartRingEnv,
  callActor: string,
  opts?: StartRingOpts,
) => Promise<{ mode: string; started: boolean }>;

interface RingTestBody {
  technician_id: string;
  trade: (typeof TRADES)[number];
  mode?: RingTestMode;
}

// Shape-check { technician_id, trade?, mode? }; trade defaults to plumbing,
// mode must be dry_run|live when present. Never throws.
function parseBody(raw: unknown): RingTestBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.technician_id !== "string" || b.technician_id === "") return null;
  let trade: RingTestBody["trade"] = "plumbing";
  if (b.trade !== undefined) {
    if (typeof b.trade !== "string" || !(TRADES as readonly string[]).includes(b.trade)) {
      return null;
    }
    trade = b.trade as RingTestBody["trade"];
  }
  if (b.mode !== undefined && b.mode !== "dry_run" && b.mode !== "live") return null;
  return {
    technician_id: b.technician_id,
    trade,
    ...(b.mode !== undefined ? { mode: b.mode as RingTestMode } : {}),
  };
}

export async function handleRingTest(
  request: Request,
  env: RingTestEnv,
  startFn: StartRingFn = startRing,
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
      event: "ring_test_fail",
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

  // One try block: a missing binding or a throwing actor both land here.
  try {
    if (env.JOBS === undefined || env.TECH === undefined) {
      throw new Error("actor_binding_missing");
    }
    const suffix = crypto.randomUUID().slice(0, 8);
    const call_ref = "sim-" + suffix;
    const job_id = "SIM-" + suffix.toUpperCase();
    const tech = env.TECH.idFromName(body.technician_id);
    const r = await tech.reserve({ call_ref, job_id, ttl_s: 90 });
    if (r.ok !== true) {
      return Response.json(
        { ok: false, error: "reserve_failed", reason: r.reason ?? "busy" },
        { status: 200 },
      );
    }
    const opened = await env.JOBS.idFromName(call_ref).open({
      job_id,
      tech_id: body.technician_id,
      urgency: "urgent",
      trade: body.trade,
      suburb: "Simville",
      summary: "Simulated ring test, no real caller",
    });
    if (!opened.ok) {
      await tech.release({ call_ref, job_id });
      return Response.json({ ok: false, error: "job_open_failed" }, { status: 200 });
    }
    const mode: RingTestMode = body.mode ?? "dry_run"; // never "off"
    await startFn(env, call_ref, { mode });
    return Response.json({ ok: true, call_ref, job_id, mode }, { status: 200 });
  } catch (err) {
    log({
      component: "ops",
      event: "ring_test_fail",
      level: "error",
      request_id,
      outcome: "fail",
      error: err instanceof Error ? err.name : "unknown",
    });
    return Response.json({ ok: false, error: "actor_failed" }, { status: 500 });
  }
}
