// src/tools/release_technician.ts
// Release the technician hold for a call and close the job record. The job_id
// comes from the JobActor record, never from the model (BUG-007). No job record
// (or an already closed one) is a no_active_reservation failure, data not an
// error. Success reports whether any pool technician is currently available.

import { TECH_POOL } from "../lib/pool";
import { oneOf, resolveCallRef } from "../lib/validate";
import type { ToolCtx, ToolEnv, ToolResult } from "./index";

const REASONS = ["declined", "no_answer", "caller_hung_up", "error"] as const;

type FailReason = "invalid_input" | "no_active_reservation";

// Every failure is data: same shape, bad_fields names only (never values).
const fail = (reason: FailReason, bad_fields: string[] = []): ToolResult => ({
  ok: false,
  reason,
  next: "fallback",
  retry: false,
  bad_fields,
});

export async function handleReleaseTechnician(
  args: unknown,
  env: ToolEnv,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const tech = env.TECH;
  const jobs = env.JOBS;
  if (tech === undefined || jobs === undefined) {
    throw new Error("namespace_missing");
  }
  const a = (args ?? {}) as Record<string, unknown>;
  const call_ref = (await resolveCallRef(a, ctx)).ref;
  const reason = oneOf(a.reason, REASONS);
  if (call_ref === null || reason === null) {
    const bad_fields: string[] = [];
    if (call_ref === null) bad_fields.push("call_ref");
    if (reason === null) bad_fields.push("reason");
    return fail("invalid_input", bad_fields);
  }

  const jobsStub = jobs.idFromName(call_ref);
  const job = await jobsStub.get();
  if (job === null || job.state === "released") {
    return fail("no_active_reservation");
  }
  const job_id = job.job_id;
  const [t, j] = await Promise.all([
    tech.idFromName(job.tech_id).release({ call_ref, job_id }),
    jobsStub.release({ job_id, reason }),
  ]);
  const released = t.released || j.released;
  const statuses = await Promise.all(
    TECH_POOL.map((id) => tech.idFromName(id).status()),
  );
  const next_technician_available = statuses.some(
    (s) => s.status === "available",
  );
  return { ok: true, released, next_technician_available };
}
