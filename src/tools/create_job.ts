// src/tools/create_job.ts
// Attach the caller's details to the active reservation ("brief" the job).
// Requires a live hold: if the JobActor still says "reserved" the hold in
// the TechnicianActor must not have expired. A replay after "briefed" skips
// the hold check. Failures as data; no customer data in error strings.

import { log, setToolLogCtx, toolLogCtxOf, type ToolLogCtx } from "../lib/log.js";
import { readConfig } from "../lib/config";
import {
  cleanText,
  normalisePhone,
  resolveCallRef,
  spoken,
} from "../lib/validate";
import type { ToolCtx, ToolEnv, ToolResult } from "./index";
import {
  startRing,
  type RingStartReason,
  type StartRingEnv,
  type StartRingResult,
} from "../lib/ringstart";

// D20-5g: hard cap on the inline ring start; a hung start never delays the
// caller's answer (the losing promise is caught, so it settles harmlessly).
const INLINE_RING_TIMEOUT_MS = 3000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([p, cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// RING_INLINE (D20-5g): unset or "1" starts the ring inline from create_job
// (the default); "0" keeps the old alarm-only path.
function ringInline(env: ToolEnv): boolean {
  return readConfig(env, "RING_INLINE") !== "0";
}

// S1.9 (BUG-005): per-hop latency, same pattern as reserve_technician.
// Time one awaited hop and write the resulting field(s) to the log context
// (no-op when called without ctx).
async function timed2<T>(
  ctx: ToolCtx | undefined,
  p: Promise<T>,
  fields: (d: number) => ToolLogCtx,
): Promise<T> {
  const start = Date.now();
  try {
    return await p;
  } finally {
    if (ctx !== undefined) setToolLogCtx(ctx, fields(Date.now() - start));
  }
}

// RING_START_DELAY_MS (D20-5b): how far ahead of create_job the multiplexed
// JobActor alarm fires the ring start. Default 1000, integer 0 to 30000.
function ringStartDelayMs(env: ToolEnv): number {
  const raw = readConfig(env, "RING_START_DELAY_MS");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 30_000 ? n : 1000;
}

// D20-5e: the single-use token for the alarm's POST /ring-start callback —
// 16 random bytes as hex. Never logged and never in any tool result.
function newRingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
  const job = await timed2(ctx, jobsStub.get(), (d) => ({ hop_job_get_ms: d }));
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
    const s = await timed2(ctx, tech.idFromName(job.tech_id).status(), (d) => ({ hop_tech_status_ms: d }));
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
  // The brief RPC IS the job write/update: kept under both hop names for
  // continuity with the S1.9 logs (S1.9b).
  const briefed = await timed2(ctx, jobsStub.brief({
    job_id,
    customer_name,
    address,
    ...(contact_phone === undefined ? {} : { contact_phone }),
    details,
    ...(hazards === undefined ? {} : { hazards }),
  }), (d) => ({ hop_brief_ms: d, hop_job_write_ms: d }));
  if (!briefed.ok) {
    return fail(briefed.reason === "invalid_input" ? "invalid_input" : "no_active_reservation");
  }
  if (job.state === "reserved") {
    // The reservation became a booked job: mark the hold so the later alarm
    // sweep clears it silently instead of logging a false hold_expired (S1.9e).
    // A failure here must not fail the call — the job is already briefed.
    // Error category only, never the message (it may embed values).
    const markStart = Date.now();
    try {
      const stub = tech.idFromName(job.tech_id) as unknown as {
        markBooked?: (a: { call_ref: string; job_id: string }) => Promise<unknown>;
      };
      await stub.markBooked?.({ call_ref, job_id });
    } catch (err) {
      log({
        component: "mcp",
        event: "mark_booked_failed",
        level: "warn",
        tool: "create_job",
        call_ref,
        job_id,
        error: err instanceof Error ? err.name : "unknown",
        ...corr,
      });
    } finally {
      if (ctx !== undefined) {
        setToolLogCtx(ctx, { hop_mark_booked_ms: Date.now() - markStart });
      }
    }
  }
  // D20-5g: the job is open — start the ring. The default (RING_INLINE unset
  // or "1") runs startRing inline in the function, which has the ring secrets,
  // under a hard 3 s cap; the outcome is stamped on the job via ringStarted.
  // A start cancels the pending alarm ring so a later alarm can never start a
  // second ring. Only a transient miss (deps_error / run_error / timeout)
  // reschedules the D20-5e alarm + single-use callback as a fallback;
  // mode_off needs nothing and capped/no_job/no_candidates already ended the
  // machine through runRing. "0" is the old alarm-only path (D20-5e). A
  // failure here is logged (error name only) and NEVER changes the create_job
  // result or failure shape.
  const ringStart = Date.now();
  try {
    if (ringInline(env)) {
      const ringEnv = (ctx?.env ?? env) as unknown as StartRingEnv;
      const startFn = ctx?.startRingFn ?? startRing;
      const opts = ctx?.ringDepsFor === undefined ? {} : { depsFor: ctx.ringDepsFor };
      const capMs =
        typeof ctx?.ringTimeoutMs === "number" && ctx.ringTimeoutMs > 0
          ? ctx.ringTimeoutMs
          : INLINE_RING_TIMEOUT_MS;
      const outcome = await withTimeout(
        startFn(ringEnv, call_ref, opts).catch(
          (): StartRingResult => ({
            mode: "dry_run",
            started: false,
            reason: "run_error",
          }),
        ),
        capMs,
      );
      const started = outcome !== "timeout" && outcome.started;
      const reason: RingStartReason =
        outcome === "timeout" ? "run_error" : outcome.reason;
      await jobsStub.ringStarted?.(reason, started);
      if (!started && (reason === "deps_error" || reason === "run_error")) {
        const origin = ctx?.origin;
        const cb =
          typeof origin === "string" && origin !== ""
            ? origin + "/ring-start"
            : undefined;
        await jobsStub.setRingAt(Date.now() + ringStartDelayMs(env), {
          token: newRingToken(),
          ...(cb === undefined ? {} : { cb }),
        });
      }
    } else {
      // D20-5e alarm-only path (RING_INLINE=0): the alarm keeps the timing
      // and POSTs the stored single-use callback so the function runs the
      // dial. RING_START_DELAY_MS applies to this path only.
      const origin = ctx?.origin;
      const cb =
        typeof origin === "string" && origin !== ""
          ? origin + "/ring-start"
          : undefined;
      await jobsStub.setRingAt(Date.now() + ringStartDelayMs(env), {
        token: newRingToken(),
        ...(cb === undefined ? {} : { cb }),
      });
    }
  } catch (err) {
    log({
      component: "mcp",
      event: "ring_schedule_fail",
      level: "warn",
      tool: "create_job",
      call_ref,
      job_id,
      error: err instanceof Error ? err.name : "unknown",
      ...corr,
    });
  } finally {
    if (ctx !== undefined) {
      setToolLogCtx(ctx, { hop_ring_ms: Date.now() - ringStart });
    }
  }
  return { ok: true, job_id, reference_spoken: spoken(job_id) };
}
