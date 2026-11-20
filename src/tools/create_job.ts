// src/tools/create_job.ts
// Attach the caller's details to the active reservation ("brief" the job).
// Requires a live hold: if the JobActor still says "reserved" the hold in
// the TechnicianActor must not have expired. A replay after "briefed" skips
// the hold check. Failures as data; no customer data in error strings.

import { log, setToolLogCtx, toolLogCtxOf, type ToolLogCtx } from "../lib/log.js";
import {
  cleanText,
  normalisePhone,
  resolveCallRef,
  spoken,
} from "../lib/validate";
import type { ToolCtx, ToolEnv, ToolResult } from "./index";

// S1.9 (BUG-005): per-hop latency, same pattern as reserve_technician.
type HopKey = "hop_job_get_ms" | "hop_tech_status_ms" | "hop_brief_ms";

// Write one hop timing to the log context (no-op when called without ctx).
async function timed2<T>(
  key: HopKey,
  ctx: ToolCtx | undefined,
  p: Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await p;
  } finally {
    if (ctx !== undefined) {
      const d = Date.now() - start;
      const fields: ToolLogCtx =
        key === "hop_job_get_ms"
          ? { hop_job_get_ms: d }
          : key === "hop_tech_status_ms"
            ? { hop_tech_status_ms: d }
            : { hop_brief_ms: d };
      setToolLogCtx(ctx, fields);
    }
  }
}

type FailReason = "invalid_input" | "no_active_reservation" | "hold_expired";

// Every failure is data: same shape, bad_fields names only (never values).
const fail = (reason: FailReason, bad_fields: string[] = []): ToolResult => ({
  ok: false,
  reason,
  next: "fallback",
  retry: false,
  bad_fields,
});

export async function handleCreateJob(
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
  // job_id from the model is ignored: the JobActor record is the truth (BUG-007).
  const customer_name = cleanText(a.customer_name, 80);
  const address = cleanText(a.address, 200);
  const details = cleanText(a.details, 500);
  // Blank optional strings ("", whitespace-only) count as "not provided".
  const blank = (v: unknown): boolean =>
    typeof v === "string" && v.trim() === "";
  // "none" / "no" / "nil" / "n/a" / "not applicable" (any case, trailing
  // punctuation) mean no hazards were provided, not a hazard named "none".
  const HAZARD_NONE = /^(none|no|nil|n\/?a|not applicable)[.!]*$/i;
  const hazardsRaw =
    a.hazards === undefined || blank(a.hazards)
      ? undefined
      : typeof a.hazards === "string" && HAZARD_NONE.test(a.hazards.trim())
        ? undefined
        : cleanText(a.hazards, 200);
  const contact_phone =
    a.contact_phone === undefined || blank(a.contact_phone)
      ? undefined
      : normalisePhone(a.contact_phone);
  if (
    call_ref === null ||
    customer_name === null ||
    address === null ||
    details === null ||
    hazardsRaw === null ||
    contact_phone === null
  ) {
    const bad_fields: string[] = [];
    if (call_ref === null) bad_fields.push("call_ref");
    if (customer_name === null) bad_fields.push("customer_name");
    if (address === null) bad_fields.push("address");
    if (contact_phone === null) bad_fields.push("contact_phone");
    if (details === null) bad_fields.push("details");
    if (hazardsRaw === null) bad_fields.push("hazards");
    return fail("invalid_input", bad_fields);
  }
  const hazards = hazardsRaw;

  const jobsStub = jobs.idFromName(call_ref);
  const job = await timed2("hop_job_get_ms", ctx, jobsStub.get());
  if (job === null || job.state === "released") {
    return fail("no_active_reservation");
  }
  const job_id = job.job_id;
  // The job has a technician: the id (never a name) goes on the mcp_call line.
  if (ctx !== undefined) setToolLogCtx(ctx, { technician_id: job.tech_id });
  const corr = ((): { request_id?: string; conv_hash?: string } => {
    const c = toolLogCtxOf(ctx);
    return { request_id: c.request_id, conv_hash: c.conv_hash };
  })();
  // Already briefed (S1.8): first write wins. Return the same success result
  // and never overwrite the stored details.
  if (job.state === "briefed") {
    log({ component: "mcp", event: "brief_replay", tool: "create_job", call_ref, job_id, ...corr });
    return { ok: true, job_id, reference_spoken: spoken(job_id) };
  }
  if (job.state === "reserved") {
    const s = await timed2("hop_tech_status_ms", ctx, tech.idFromName(job.tech_id).status());
    const h = s.held_for;
    if (
      h === undefined ||
      h.call_ref !== call_ref ||
      h.job_id !== job_id ||
      h.expires_at <= Date.now()
    ) {
      return fail("hold_expired");
    }
  }

  // The JobActor keeps the callback stored at reservation (first confirmed
  // wins) and drops "none"-style hazards, so pass both through as-is.
  const briefed = await timed2("hop_brief_ms", ctx, jobsStub.brief({
    job_id,
    customer_name,
    address,
    ...(contact_phone === undefined ? {} : { contact_phone }),
    details,
    ...(hazards === undefined ? {} : { hazards }),
  }));
  if (!briefed.ok) {
    return fail(briefed.reason === "invalid_input" ? "invalid_input" : "no_active_reservation");
  }
  if (job.state === "reserved") {
    // The reservation became a booked job: mark the hold so the later alarm
    // sweep clears it silently instead of logging a false hold_expired (S1.9e).
    const stub = tech.idFromName(job.tech_id) as unknown as {
      markBooked?: (a: { call_ref: string; job_id: string }) => Promise<unknown>;
    };
    await stub.markBooked?.({ call_ref, job_id });
  }
  return { ok: true, job_id, reference_spoken: spoken(job_id) };
}
