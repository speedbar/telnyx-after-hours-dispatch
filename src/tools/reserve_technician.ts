// src/tools/reserve_technician.ts
// Reserve an on-call technician for a call: deterministic hold in the
// TechnicianActor, job record in the JobActor (instance name = call_ref, so
// idempotency by call_ref falls out of the actor name). All failures carry
// next:"fallback" so the voice flow never hits a dead end. Input is
// untrusted model output: validate first, failures as data.

import { readConfig } from "../lib/config";
import { log, setToolLogCtx, toolLogCtxOf, type ToolLogCtx } from "../lib/log.js";
import { TECH_POOL, TECH_PROFILES, type Trade } from "../lib/pool";
import {
  applyFloors,
  cleanText,
  dialableCallback,
  jobFlags,
  jobIdFromCallRef,
  oneOf,
  resolveCallRef,
} from "../lib/validate";
import type { ToolCtx, ToolEnv, ToolResult } from "./index";

const URGENCIES = ["emergency", "urgent"] as const;
const TRADES = ["plumbing", "electrical", "gas", "hvac", "other"] as const;

// S1.9 (BUG-005): per-hop latency. Each awaited actor hop is timed with
// Date.now() differences and stashed on the tool-call log context; the route
// puts the numbers on the mcp_call line. tech_reserve is a SUM across attempts.
type HopKey = "hop_flag_ms" | "hop_job_get_ms" | "hop_tech_ms" | "hop_job_open_ms";

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
  // Write one hop timing to the log context (no-op when called without ctx).
  const hop = (fields: ToolLogCtx): void => {
    if (ctx !== undefined) setToolLogCtx(ctx, fields);
  };
  const time = async <T>(key: HopKey, p: Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await p;
    } finally {
      const d = Date.now() - start;
      if (key === "hop_tech_ms") {
        hop({ hop_tech_ms: (toolLogCtxOf(ctx).hop_tech_ms ?? 0) + d });
      } else if (key === "hop_flag_ms") {
        hop({ hop_flag_ms: d });
      } else if (key === "hop_job_get_ms") {
        hop({ hop_job_get_ms: d });
      } else {
        hop({ hop_job_open_ms: d });
      }
    }
  };
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
  // Hard reject only an undiallable callback (S1.8); everything else is flagged.
  const callback_number = dialableCallback(a.callback_number);
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

  // Severity and trade floors (S1.8): the effective values are what is
  // stored and used for eligibility. Event names only, never values.
  const floored = applyFloors(trade, urgency, summary);
  if (floored.raised) {
    log({ component: "mcp", event: "urgency_raised", tool: "reserve_technician", call_ref });
  }
  if (floored.corrected) {
    log({ component: "mcp", event: "trade_corrected", tool: "reserve_technician", call_ref });
  }
  // Soft flags: the job is accepted and reviewed by a human later (D19).
  const flags = jobFlags({ customer_name, address, suburb });

  const job_id = await jobIdFromCallRef(call_ref);
  const ttl_s = holdTtl(env);
  const [flag, job] = await Promise.all([
    time("hop_flag_ms", dir.idFromName("directory").flag("dispatch_enabled")),
    time("hop_job_get_ms", jobs.idFromName(call_ref).get()),
  ]);
  if (flag === "false") return fail("disabled");

  // Replay or continuation of an existing job: refresh the hold idempotently.
  if (job !== null) {
    if (job.state === "released") return fail("already_closed");
    const r = await time(
      "hop_tech_ms",
      tech.idFromName(job.tech_id).reserve({ call_ref, job_id: job.job_id, ttl_s }),
    );
    if (!r.ok) return fail("no_technician_available");
    const attempt = Math.max(1, (TECH_POOL as readonly string[]).indexOf(job.tech_id) + 1);
    return success(job.job_id, r.expires_at, attempt);
  }

  // Eligibility by licensed trade (S1.8): try only technicians whose trades
  // include the effective trade, in pool order. attempt is 1-based within
  // this eligible list.
  const eligible = TECH_POOL.filter((id) => {
    const profile = TECH_PROFILES[id];
    return profile.trades.includes(floored.trade as Trade);
  });
  log({
    component: "mcp",
    event: "reserve_attempt",
    tool: "reserve_technician",
    call_ref,
    eligible_count: eligible.length,
  });

  for (let i = 0; i < eligible.length; i++) {
    const tech_id = eligible[i];
    const r = await time(
      "hop_tech_ms",
      tech.idFromName(tech_id).reserve({ call_ref, job_id, ttl_s }),
    );
    if (!r.ok) continue;
    const opened = await time("hop_job_open_ms", jobs.idFromName(call_ref).open({
      job_id,
      tech_id,
      urgency: floored.urgency,
      trade: floored.trade,
      suburb,
      summary,
      flags,
      customer_name,
      address,
      contact_phone: callback_number,
    }));
    if (!opened.ok) {
      await tech.idFromName(tech_id).release({ call_ref, job_id });
      return fail(mapOpenReason(opened.reason));
    }
    return success(job_id, r.expires_at, i + 1);
  }
  return fail("no_technician_available");
}
