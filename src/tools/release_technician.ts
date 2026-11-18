// src/tools/release_technician.ts
// Release the technician hold for a call and close the job record. Safe to
// call repeatedly: unknown or mismatched jobs are released:false, never an
// error. Always reports whether any pool technician is currently available.

import { TECH_POOL } from "../lib/pool";
import { isCallRef, isJobId, oneOf } from "../lib/validate";
import type { ToolEnv, ToolResult } from "./index";

const REASONS = ["declined", "no_answer", "caller_hung_up", "error"] as const;

export async function handleReleaseTechnician(
  args: unknown,
  env: ToolEnv,
): Promise<ToolResult> {
  const tech = env.TECH;
  const jobs = env.JOBS;
  if (tech === undefined || jobs === undefined) {
    throw new Error("namespace_missing");
  }
  const a = (args ?? {}) as Record<string, unknown>;
  const call_ref = isCallRef(a.call_ref) ? a.call_ref : null;
  const job_id = isJobId(a.job_id) ? a.job_id : null;
  const reason = oneOf(a.reason, REASONS);
  if (call_ref === null || job_id === null || reason === null) {
    return { ok: false, reason: "invalid_input" };
  }

  const jobsStub = jobs.idFromName(call_ref);
  const job = await jobsStub.get();
  let released = false;
  if (job !== null && job.job_id === job_id && job.state !== "released") {
    const [t, j] = await Promise.all([
      tech.idFromName(job.tech_id).release({ call_ref, job_id }),
      jobsStub.release({ job_id, reason }),
    ]);
    released = t.released || j.released;
  }
  const statuses = await Promise.all(
    TECH_POOL.map((id) => tech.idFromName(id).status()),
  );
  const next_technician_available = statuses.some(
    (s) => s.status === "available",
  );
  return { ok: true, released, next_technician_available };
}
