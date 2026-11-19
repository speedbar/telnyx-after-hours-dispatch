// src/tools/reserve_technician.ts
// Reserve an on-call technician for a call: deterministic hold in the
// TechnicianActor, job record in the JobActor (instance name = call_ref, so
// idempotency by call_ref falls out of the actor name). All failures carry
// next:"fallback" so the voice flow never hits a dead end. Input is
// untrusted model output: validate first, failures as data.

import { readConfig } from "../lib/config";
import { TECH_POOL } from "../lib/pool";
import {
  cleanText,
  jobIdFromCallRef,
  normalisePhone,
  oneOf,
  resolveCallRef,
} from "../lib/validate";
import type { ToolCtx, ToolEnv, ToolResult } from "./index";

const URGENCIES = ["emergency", "urgent"] as const;
const TRADES = ["plumbing", "electrical", "gas", "hvac", "other"] as const;

type FailReason = "invalid_input" | "disabled" | "already_closed" | "no_technician_available";

// Every failure is data: same shape, bad_fields names only (never values).
const fail = (reason: FailReason, bad_fields: string[] = []): ToolResult => ({
  ok: false,
  reason,
  next: "fallback",
  retry: false,
  bad_fields,
});

function holdTtl(env: ToolEnv): number {
  const raw = readConfig(env, "DISPATCH_HOLD_TTL_S");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 600 ? n : 90;
}

// Reservation only: no technician identity or ETA in the result, so the model
// cannot promise a name or an arrival time (BUG-013).
function success(job_id: string, expires_at: number, attempt: number): ToolResult {
  return {
    ok: true,
    job_id,
    hold_expires_at: new Date(expires_at).toISOString(),
    attempt,
  };
}

// JobActor.open reasons -> the allowed failure list of this tool.
function mapOpenReason(reason: string): FailReason {
  if (reason === "invalid_input" || reason === "already_closed") return reason;
  return "already_closed"; // job_mismatch: deterministic ids make this unreachable
}

export async function handleReserveTechnician(
  args: unknown,
  env: ToolEnv,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const dir = env.DIRECTORY;
  const tech = env.TECH;
  const jobs = env.JOBS;
  if (dir === undefined || tech === undefined || jobs === undefined) {
    throw new Error("namespace_missing");
  }
  const a = (args ?? {}) as Record<string, unknown>;
  const call_ref = (await resolveCallRef(a, ctx)).ref;
  const urgency = oneOf(a.urgency, URGENCIES);
  const trade = oneOf(a.trade, TRADES);
  const suburb = cleanText(a.suburb, 60);
  const summary = cleanText(a.summary, 200);
  // Caller details are required so the model cannot reserve before it has
  // asked for them (BUG-006). Validate only; not stored in this task.
  const customer_name = cleanText(a.customer_name, 80);
  const address = cleanText(a.address, 200);
  const callback_number = normalisePhone(a.callback_number);
  if (
    call_ref === null ||
    urgency === null ||
    trade === null ||
    suburb === null ||
    summary === null ||
    customer_name === null ||
    address === null ||
    callback_number === null
  ) {
    const bad_fields: string[] = [];
    if (call_ref === null) bad_fields.push("call_ref");
    if (customer_name === null) bad_fields.push("customer_name");
    if (address === null) bad_fields.push("address");
    if (callback_number === null) bad_fields.push("callback_number");
    if (urgency === null) bad_fields.push("urgency");
    if (trade === null) bad_fields.push("trade");
    if (suburb === null) bad_fields.push("suburb");
    if (summary === null) bad_fields.push("summary");
    return fail("invalid_input", bad_fields);
  }

  const job_id = await jobIdFromCallRef(call_ref);
  const ttl_s = holdTtl(env);
  const [flag, job] = await Promise.all([
    dir.idFromName("directory").flag("dispatch_enabled"),
    jobs.idFromName(call_ref).get(),
  ]);
  if (flag === "false") return fail("disabled");

  // Replay or continuation of an existing job: refresh the hold idempotently.
  if (job !== null) {
    if (job.state === "released") return fail("already_closed");
    const r = await tech
      .idFromName(job.tech_id)
      .reserve({ call_ref, job_id: job.job_id, ttl_s });
    if (!r.ok) return fail("no_technician_available");
    const attempt = Math.max(1, (TECH_POOL as readonly string[]).indexOf(job.tech_id) + 1);
    return success(job.job_id, r.expires_at, attempt);
  }

  for (let i = 0; i < TECH_POOL.length; i++) {
    const tech_id = TECH_POOL[i];
    const r = await tech
      .idFromName(tech_id)
      .reserve({ call_ref, job_id, ttl_s });
    if (!r.ok) continue;
    const opened = await jobs.idFromName(call_ref).open({
      job_id,
      tech_id,
      urgency,
      trade,
      suburb,
      summary,
    });
    if (!opened.ok) {
      await tech.idFromName(tech_id).release({ call_ref, job_id });
      return fail(mapOpenReason(opened.reason));
    }
    return success(job_id, r.expires_at, i + 1);
  }
  return fail("no_technician_available");
}
