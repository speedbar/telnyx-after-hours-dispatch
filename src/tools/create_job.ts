// src/tools/create_job.ts
// Attach the caller's details to the active reservation ("brief" the job).
// Requires a live hold: if the JobActor still says "reserved" the hold in
// the TechnicianActor must not have expired. A replay after "briefed" skips
// the hold check. Failures as data; no customer data in error strings.

import {
  cleanText,
  isCallRef,
  isJobId,
  normalisePhone,
  spoken,
} from "../lib/validate";
import type { ToolEnv, ToolResult } from "./index";

export async function handleCreateJob(
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
  const customer_name = cleanText(a.customer_name, 80);
  const address = cleanText(a.address, 200);
  const details = cleanText(a.details, 500);
  const hazards =
    a.hazards === undefined ? undefined : cleanText(a.hazards, 200);
  const contact_phone =
    a.contact_phone === undefined ? undefined : normalisePhone(a.contact_phone);
  if (
    call_ref === null ||
    job_id === null ||
    customer_name === null ||
    address === null ||
    details === null ||
    hazards === null ||
    contact_phone === null
  ) {
    return { ok: false, reason: "invalid_input" };
  }

  const jobsStub = jobs.idFromName(call_ref);
  const job = await jobsStub.get();
  if (job === null || job.job_id !== job_id || job.state === "released") {
    return { ok: false, reason: "no_active_reservation" };
  }
  if (job.state === "reserved") {
    const s = await tech.idFromName(job.tech_id).status();
    const h = s.held_for;
    if (
      h === undefined ||
      h.call_ref !== call_ref ||
      h.job_id !== job_id ||
      h.expires_at <= Date.now()
    ) {
      return { ok: false, reason: "hold_expired", next: "fallback" };
    }
  }

  const briefed = await jobsStub.brief({
    job_id,
    customer_name,
    address,
    ...(contact_phone === undefined ? {} : { contact_phone }),
    details,
    ...(hazards === undefined ? {} : { hazards }),
  });
  if (!briefed.ok) return { ok: false, reason: briefed.reason };
  return { ok: true, job_id, reference_spoken: spoken(job_id) };
}
