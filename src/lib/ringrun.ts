// src/lib/ringrun.ts
// D20-4a ring harness: executes the pure reducer's effects against injected,
// fully fakeable deps. Feedback (reserve_result / dial_result / the synthetic
// gather on a failed prompt command) is fed back through jobs.ringEvent,
// bounded at RING_RUN_MAX_ITERATIONS. One failing effect never stops the rest
// and nothing here throws. Every executed effect logs ring_effect; a failure
// adds ring_effect_fail with a reason code. job_state and log effects are
// log-only. Never logs phone numbers, the brief text or the API key; the
// brief is always read fresh from the JobActor, never from the event.

import { log } from "./log";
import { buildBrief } from "./brief";
import { encodeClientState, type TelnyxClient } from "./telnyx-api";
import { spoken } from "./validate";
import type { TechPhones } from "./techphones";
import type { Dialer, RingEffect, RingEvent, RingState } from "./ring";

export const RING_RUN_MAX_ITERATIONS = 8;

// Structural subset of the JobActor record the ring needs. `ring` carries the
// pre-event machine snapshot: runRing is invoked per webhook event and the
// reducer's post-state may already point at the next candidate, so the leg on
// the phone (and the attempt for sys-gather-fail ids) comes from here.
export interface RingJob {
  job_id: string;
  urgency: string;
  trade: string;
  suburb: string;
  summary: string;
  customer_name?: string;
  address?: string;
  contact_phone?: string;
  hazards?: string;
  ring?: RingState;
}

export interface RingJobs {
  ringEvent(event: RingEvent): Promise<{ state: RingState | null; effects: RingEffect[] }>;
  get(): Promise<RingJob | null>;
}

// TechnicianActor stub shape (real methods are structurally assignable).
export interface RingTech {
  // D20-5a: optional; startRing's cooldown filter reads last_ring_at off it.
  status?(): Promise<unknown>;
  reserve(args: {
    call_ref: string;
    job_id: string;
    ttl_s?: number;
  }): Promise<{ ok: boolean; reason?: string }>;
  extendHold(args: {
    call_ref: string;
    job_id: string;
    ttl_s?: number;
  }): Promise<{ extended: boolean }>;
  release(args: { call_ref: string; job_id: string }): Promise<{ released: boolean }>;
  dispatch(args: {
    call_ref: string;
    job_id: string;
    busy_s?: number;
  }): Promise<{ ok: boolean; reason?: string }>;
}

export interface RunRingDeps {
  jobs: RingJobs;
  tech(id: string): RingTech;
  client: TelnyxClient;
  dialer: Dialer; // already wrapped in withDialGate by the caller
  phones: TechPhones;
  voice: string;
  language: string;
  holdTtlS: number; // RING_HOLD_TTL_S per attempt; reserve and extendHold share it
  busyS: number; // DISPATCH_BUSY_S
}

// Mutable leg context across the loop: ccid is the leg we currently have on
// the phone (the most recent non-empty call_control_id the reducer reported —
// state.current may already point at the next candidate when hangup_call
// executes, which is why we track it separately).
interface RingCtx {
  call_ref: string;
  job_id: string;
  ccid?: string;
  attempt: number;
}

function effectLog(ctx: RingCtx, eff: RingEffect, ok: boolean): void {
  const tid = "technician_id" in eff ? eff.technician_id : undefined;
  log({
    component: "ops",
    event: "ring_effect",
    node: eff.type,
    outcome: ok ? "ok" : "fail",
    call_ref: ctx.call_ref,
    job_id: ctx.job_id,
    ...(tid !== undefined ? { technician_id: tid } : {}),
  });
}

function failLog(ctx: RingCtx, type: string, reason: string, tid?: string): void {
  log({
    component: "ops",
    level: "warn",
    event: "ring_effect_fail",
    node: type,
    outcome: "fail",
    error: reason.length > 80 ? reason.slice(0, 80) : reason,
    call_ref: ctx.call_ref,
    job_id: ctx.job_id,
    ...(tid !== undefined ? { technician_id: tid } : {}),
  });
}

// A failed prompt command moves the machine on as if the prompt had timed
// out (digits ""), so the attempt ends as no_input instead of hanging open.
function synthGather(ctx: RingCtx): RingEvent {
  return {
    type: "gather",
    call_control_id: ctx.ccid ?? "",
    digits: "",
    event_id: "sys-gather-fail-" + String(ctx.attempt),
    now: Date.now(),
  };
}

// Executes one effect; returns the feedback event to feed back through
// jobs.ringEvent, or undefined. Never throws.
async function execute(
  deps: RunRingDeps,
  ctx: RingCtx,
  eff: RingEffect,
): Promise<RingEvent | undefined> {
  switch (eff.type) {
    case "log":
      log({
        component: "ops",
        event: eff.event,
        call_ref: ctx.call_ref,
        job_id: ctx.job_id,
        ...(eff.mode !== undefined ? { node: eff.mode } : {}),
        ...(eff.technician_id !== undefined ? { technician_id: eff.technician_id } : {}),
        ...(eff.attempt !== undefined ? { attempt: eff.attempt } : {}),
        ...(eff.outcome !== undefined ? { outcome: eff.outcome } : {}),
        ...(eff.reason !== undefined ? { error: eff.reason } : {}),
      });
      effectLog(ctx, eff, true);
      return undefined;

    case "job_state":
      log({
        component: "ops",
        event: "ring_job_state",
        node: eff.state,
        outcome: "ok",
        call_ref: ctx.call_ref,
        job_id: ctx.job_id,
      });
      effectLog(ctx, eff, true);
      return undefined;

    case "reserve": {
      const id = eff.technician_id;
      try {
        const r = await deps.tech(id).reserve({
          call_ref: ctx.call_ref,
          job_id: ctx.job_id,
          ttl_s: deps.holdTtlS,
        });
        const ok = r.ok === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, r.reason ?? "reserve_failed", id);
        return { type: "reserve_result", technician_id: id, ok, now: Date.now() };
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception", id);
        return { type: "reserve_result", technician_id: id, ok: false, now: Date.now() };
      }
    }

    case "extend_hold": {
      const id = eff.technician_id;
      try {
        const r = await deps.tech(id).extendHold({
          call_ref: ctx.call_ref,
          job_id: ctx.job_id,
          ttl_s: deps.holdTtlS,
        });
        const ok = r.extended === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, "not_extended", id);
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception", id);
      }
      return undefined;
    }

    case "dial": {
      const id = eff.technician_id;
      const digits = deps.phones.phones[id];
      if (digits === undefined) {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "no_phone", id); // ids only, never a number
        return { type: "dial_result", ok: false, now: Date.now() };
      }
      try {
        const r = await deps.dialer(digits, {
          client_state: encodeClientState({ c: ctx.call_ref, j: ctx.job_id, t: id, a: eff.attempt }),
          command_id: "ring-" + ctx.job_id + "-" + String(eff.attempt),
        });
        const ok = r.ok === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, r.reason ?? "dial_failed", id);
        return {
          type: "dial_result",
          ok,
          ...(ok && typeof r.call_control_id === "string" ? { call_control_id: r.call_control_id } : {}),
          now: Date.now(),
        };
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception", id);
        return { type: "dial_result", ok: false, now: Date.now() };
      }
    }

    case "gather_prompt": {
      let payload: string;
      try {
        const job = await deps.jobs.get(); // read the JobActor, never the event
        if (job === null) {
          effectLog(ctx, eff, false);
          failLog(ctx, eff.type, "no_job");
          return synthGather(ctx);
        }
        payload = buildBrief({
          job_id: job.job_id,
          urgency: job.urgency,
          trade: job.trade,
          suburb: job.suburb,
          summary: job.summary,
          ...(job.customer_name !== undefined ? { customer_name: job.customer_name } : {}),
          ...(job.address !== undefined ? { address: job.address } : {}),
          ...(job.contact_phone !== undefined ? { contact_phone: job.contact_phone } : {}),
          ...(job.hazards !== undefined ? { hazards: job.hazards } : {}),
        });
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception");
        return synthGather(ctx);
      }
      if (ctx.ccid === undefined) {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "no_leg");
        return undefined; // nothing sane to feed; the attempt dies with the leg
      }
      try {
        const r = await deps.client.gatherUsingSpeak(ctx.ccid, {
          payload,
          voice: deps.voice,
          language: deps.language,
        });
        const ok = r.ok === true;
        effectLog(ctx, eff, ok);
        if (!ok) {
          failLog(ctx, eff.type, r.reason ?? "gather_failed");
          return synthGather(ctx);
        }
        return undefined;
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception");
        return synthGather(ctx);
      }
    }

    case "hangup_call": {
      if (ctx.ccid === undefined) {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "no_leg");
        return undefined;
      }
      try {
        const r = await deps.client.hangup(ctx.ccid);
        const ok = r.ok === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, r.reason ?? "hangup_failed");
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception");
      }
      return undefined;
    }

    case "release": {
      const id = eff.technician_id;
      try {
        const r = await deps.tech(id).release({ call_ref: ctx.call_ref, job_id: ctx.job_id });
        const ok = r.released === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, "not_released", id);
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception", id);
      }
      return undefined;
    }

    case "mark_dispatched": {
      const id = eff.technician_id;
      try {
        const r = await deps.tech(id).dispatch({
          call_ref: ctx.call_ref,
          job_id: ctx.job_id,
          busy_s: deps.busyS,
        });
        const ok = r.ok === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, r.reason ?? "dispatch_failed", id);
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception", id);
      }
      return undefined;
    }

    case "confirm_hangup": {
      // Speak the acceptance confirmation; the hangup itself is done later by
      // the voice route on call.speak.ended (D20-4), not here.
      if (ctx.ccid === undefined) {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "no_leg");
        return undefined;
      }
      try {
        const r = await deps.client.speak(ctx.ccid, {
          payload:
            "Thank you. Job accepted. Reference " + spoken(ctx.job_id) + ". Goodbye.",
          voice: deps.voice,
          language: deps.language,
        });
        const ok = r.ok === true;
        effectLog(ctx, eff, ok);
        if (!ok) failLog(ctx, eff.type, r.reason ?? "speak_failed");
      } catch {
        effectLog(ctx, eff, false);
        failLog(ctx, eff.type, "exception");
      }
      return undefined;
    }
  }
}

export async function runRing(
  deps: RunRingDeps,
  callActor: string,
  event: RingEvent,
): Promise<void> {
  const ctx: RingCtx = { call_ref: callActor, job_id: "", attempt: 0 };
  // job_id feeds reserve/extend_hold/dispatch args, the dial client_state and
  // command_id; the brief re-reads the record at gather_prompt time. The
  // pre-event ring snapshot seeds the leg on the phone and the attempt.
  try {
    const job0 = await deps.jobs.get();
    if (job0 !== null) {
      ctx.job_id = job0.job_id;
      const ccid = job0.ring?.current?.call_control_id;
      if (typeof ccid === "string" && ccid !== "") ctx.ccid = ccid;
      ctx.attempt = job0.ring?.attempt ?? 0;
    }
  } catch {
    // Continue with "": dependent effects fail as data, never as exceptions.
  }

  let iterations = 0;
  const feed = async (ev: RingEvent): Promise<RingEffect[]> => {
    iterations += 1;
    try {
      const res = await deps.jobs.ringEvent(ev);
      if (res.state === null) return []; // no job record: nothing to do
      ctx.attempt = res.state.attempt;
      const ccid = res.state.current?.call_control_id;
      if (typeof ccid === "string" && ccid !== "") ctx.ccid = ccid;
      return res.effects;
    } catch {
      failLog(ctx, "feed", "ringevent_error");
      return [];
    }
  };

  // FIFO queue keeps the reducer's effect order; feedback effects are
  // appended, so each event's own effects all run before its feedback's.
  // Copy the batch: deps may retain (or reuse) the arrays they return.
  const queue: RingEffect[] = [...(await feed(event))];
  while (queue.length > 0) {
    const eff = queue.shift()!;
    let feedback: RingEvent | undefined;
    try {
      feedback = await execute(deps, ctx, eff);
    } catch {
      failLog(ctx, eff.type, "exception"); // execute never throws; belt and braces
      continue;
    }
    if (feedback === undefined) continue;
    if (iterations >= RING_RUN_MAX_ITERATIONS) {
      failLog(ctx, "feed", "iteration_cap");
      continue;
    }
    queue.push(...(await feed(feedback)));
  }
}
