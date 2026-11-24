import { StatefulActor, type AlarmInfo } from "@telnyx/edge-runtime";
import { readConfig } from "../lib/config";
import { log } from "../lib/log.js";

type TechStatus = "available" | "held" | "off_shift" | "dispatched";

interface TechState {
  id: string;
  status: TechStatus;
  // created_at: hold start (hold length = expires_at - created_at). booked:
  // create_job consumed the reservation — the expiry sweep stays silent.
  held_for?: {
    call_ref: string;
    job_id: string;
    expires_at: number;
    created_at?: number;
    booked?: boolean;
  };
  // D20: set only on an explicit accept; reserve answers "busy" until then.
  dispatched_for?: {
    call_ref: string;
    job_id: string;
    until: number;
  };
  // D20-5a: when a ring attempt last extended the hold (startRing cooldown).
  last_ring_at?: number;
  updated_at: number;
}

type ReserveResult =
  | { ok: true; expires_at: number }
  | { ok: false; reason: "busy" | "off_shift" | "invalid_input" };

// D20: how long an accepted job keeps the technician busy. DISPATCH_BUSY_S,
// default 1800, accepts integer seconds 1 to 86400.
function dispatchBusyS(env: unknown): number {
  const raw = readConfig(env, "DISPATCH_BUSY_S");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 86400 ? n : 1800;
}

export class TechnicianActor extends StatefulActor {
  async ping(): Promise<{ pong: boolean; count: number }> {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return { pong: true, count };
  }

  // Read state once; lazily clear an expired hold and an expired dispatch. A
  // hold lapse logs exactly one hold_expired line (technician id + hold length
  // in latency_ms). A dispatch lapse logs one tech_dispatch_expired line. The
  // cleared state is persisted here so no later read can log again (S1.9e). A
  // hold already consumed by create_job (booked) is swept silently.
  private async _state(): Promise<{ state: TechState; cleared: boolean }> {
    const stored = await this.ctx.storage.get<TechState>("state");
    const ctxId = (this.ctx as { id?: unknown }).id;
    const state: TechState =
      stored ??
      ({
        id: typeof ctxId === "string" && ctxId ? ctxId : "tech",
        status: "available",
        updated_at: 0,
      } satisfies TechState);
    const now = Date.now();
    let cleared = false;
    if (state.held_for && state.held_for.expires_at <= now) {
      const held = state.held_for;
      if (held.booked !== true) {
        log({
          component: "actor",
          event: "hold_expired",
          technician_id: state.id,
          call_ref: held.call_ref,
          job_id: held.job_id,
          latency_ms: Math.max(0, held.expires_at - (held.created_at ?? state.updated_at)),
        });
      }
      delete state.held_for;
      if (state.status === "held") state.status = "available";
      cleared = true;
    }
    if (state.dispatched_for && state.dispatched_for.until <= now) {
      const disp = state.dispatched_for;
      log({
        component: "actor",
        event: "tech_dispatch_expired",
        technician_id: state.id,
        call_ref: disp.call_ref,
        job_id: disp.job_id,
      });
      delete state.dispatched_for;
      if (state.status === "dispatched") state.status = "available";
      cleared = true;
    }
    if (cleared) {
      state.updated_at = now;
      await this.ctx.storage.put("state", state);
    }
    return { state, cleared };
  }

  // Re-arm the one alarm to whichever of hold / dispatch expires first; with
  // neither pending there is nothing to wake for.
  private async _rearm(state: TechState): Promise<void> {
    const times = [state.held_for?.expires_at, state.dispatched_for?.until].filter(
      (t): t is number => t !== undefined,
    );
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async reserve(args: {
    call_ref: string;
    job_id: string;
    ttl_s?: number;
  }): Promise<ReserveResult> {
    const { state } = await this._state();
    const { call_ref, job_id } = args;
    const ttl = args.ttl_s === undefined ? 90 : args.ttl_s;
    const valid =
      typeof call_ref === "string" &&
      call_ref.length > 0 &&
      typeof job_id === "string" &&
      job_id.length > 0 &&
      Number.isInteger(ttl) &&
      ttl >= 1 &&
      ttl <= 600;
    if (!valid) {
      log({ component: "actor", event: "reserve_attempt", outcome: "rejected", technician_id: state.id, error: "invalid_input" });
      return { ok: false, reason: "invalid_input" };
    }
    if (state.status === "off_shift") {
      log({ component: "actor", event: "reserve_attempt", outcome: "rejected", technician_id: state.id, call_ref, job_id, error: "off_shift" });
      return { ok: false, reason: "off_shift" };
    }
    // D20: dispatched keeps the technician busy for the whole busy period.
    if (state.dispatched_for !== undefined) {
      log({ component: "actor", event: "reserve_attempt", outcome: "rejected", technician_id: state.id, call_ref, job_id, error: "busy" });
      return { ok: false, reason: "busy" };
    }
    if (state.held_for) {
      if (state.held_for.call_ref === call_ref) {
        log({ component: "actor", event: "reserve_attempt", outcome: "ok", technician_id: state.id, call_ref, job_id });
        return { ok: true, expires_at: state.held_for.expires_at };
      }
      log({ component: "actor", event: "reserve_attempt", outcome: "rejected", technician_id: state.id, call_ref, job_id, error: "busy" });
      return { ok: false, reason: "busy" };
    }
    const now = Date.now();
    const expires_at = now + ttl * 1000;
    await this.ctx.storage.put("state", {
      ...state,
      status: "held",
      held_for: { call_ref, job_id, expires_at, created_at: now },
      updated_at: now,
    } satisfies TechState);
    await this.ctx.storage.setAlarm(expires_at);
    log({ component: "actor", event: "reserve_attempt", outcome: "ok", technician_id: state.id, call_ref, job_id });
    return { ok: true, expires_at };
  }

  async release(args: { call_ref: string; job_id: string }): Promise<{ released: boolean }> {
    try {
      const { state } = await this._state();
      const { call_ref, job_id } = args;
      if (!state.held_for || state.held_for.call_ref !== call_ref || state.held_for.job_id !== job_id) {
        return { released: false };
      }
      const next: TechState = { ...state, status: "available", updated_at: Date.now() };
      delete next.held_for;
      await this.ctx.storage.put("state", next);
      await this._rearm(next);
      log({ component: "actor", event: "release", outcome: "ok", technician_id: state.id, call_ref, job_id });
      return { released: true };
    } catch {
      return { released: false };
    }
  }

  async status(): Promise<TechState> {
    const { state } = await this._state();
    return state;
  }

  // create_job consumed this hold: the expiry sweep clears it silently.
  async markBooked(args: { call_ref: string; job_id: string }): Promise<{ booked: boolean }> {
    const { state } = await this._state();
    if (!state.held_for || state.held_for.call_ref !== args.call_ref || state.held_for.job_id !== args.job_id) {
      return { booked: false };
    }
    state.held_for.booked = true;
    await this.ctx.storage.put("state", state);
    return { booked: true };
  }

  // D20: a ringing attempt can outlive the original 90 s hold. Same call_ref
  // and job_id only; moves the alarm to the new expires_at and never touches
  // the booked flag, so no false hold_expired is logged.
  async extendHold(args: {
    call_ref: string;
    job_id: string;
    ttl_s?: number;
  }): Promise<{ extended: boolean }> {
    const { state } = await this._state();
    const ttl = args.ttl_s === undefined ? 60 : args.ttl_s;
    const valid =
      typeof args.call_ref === "string" &&
      args.call_ref.length > 0 &&
      typeof args.job_id === "string" &&
      args.job_id.length > 0 &&
      Number.isInteger(ttl) &&
      ttl >= 1 &&
      ttl <= 86400;
    if (!valid) return { extended: false };
    if (
      !state.held_for ||
      state.held_for.call_ref !== args.call_ref ||
      state.held_for.job_id !== args.job_id
    ) {
      return { extended: false };
    }
    const nowMs = Date.now();
    state.held_for.expires_at = nowMs + ttl * 1000;
    state.last_ring_at = nowMs;
    state.updated_at = nowMs;
    await this.ctx.storage.put("state", state);
    await this._rearm(state);
    return { extended: true };
  }

  // D20: explicit accept only (the reducer is the guard). Clears the hold,
  // marks the technician dispatched until now + busy_s, and arms the alarm.
  // Refuses when another job holds the technician (held_by_other, the foreign
  // hold is left intact) or another job is dispatched (busy). A repeat for the
  // same dispatched job returns the original until (idempotent); a matching
  // hold or no hold at all (lapsed mid-ring) succeeds.
  async dispatch(args: {
    call_ref: string;
    job_id: string;
    busy_s?: number;
  }): Promise<
    { ok: true; until: number } | { ok: false; reason: "invalid_input" | "held_by_other" | "busy" }
  > {
    const { state } = await this._state();
    const busy = args.busy_s === undefined ? dispatchBusyS(this.env) : args.busy_s;
    const valid =
      typeof args.call_ref === "string" &&
      args.call_ref.length > 0 &&
      typeof args.job_id === "string" &&
      args.job_id.length > 0 &&
      Number.isInteger(busy) &&
      busy >= 1 &&
      busy <= 86400;
    if (!valid) return { ok: false, reason: "invalid_input" };
    if (state.dispatched_for) {
      if (state.dispatched_for.call_ref === args.call_ref && state.dispatched_for.job_id === args.job_id) {
        return { ok: true, until: state.dispatched_for.until };
      }
      log({ component: "actor", event: "dispatch_attempt", outcome: "rejected", technician_id: state.id, call_ref: args.call_ref, job_id: args.job_id, error: "busy" });
      return { ok: false, reason: "busy" };
    }
    if (
      state.held_for &&
      (state.held_for.call_ref !== args.call_ref || state.held_for.job_id !== args.job_id)
    ) {
      log({ component: "actor", event: "dispatch_attempt", outcome: "rejected", technician_id: state.id, call_ref: args.call_ref, job_id: args.job_id, error: "held_by_other" });
      return { ok: false, reason: "held_by_other" };
    }
    const now = Date.now();
    const until = now + busy * 1000;
    const next: TechState = {
      ...state,
      status: "dispatched",
      dispatched_for: { call_ref: args.call_ref, job_id: args.job_id, until },
      updated_at: now,
    };
    delete next.held_for;
    await this.ctx.storage.put("state", next);
    await this._rearm(next);
    log({ component: "actor", event: "tech_dispatched", technician_id: state.id, call_ref: args.call_ref, job_id: args.job_id });
    return { ok: true, until };
  }

  // D20: admin/demo escape hatch, frees a dispatched technician early. T1.6:
  // also frees a live hold (per-repeat test reset) and reports what it
  // cleared. off_shift is never flipped: setShift already drops both
  // pointers, so there is nothing to clear and the status guard only maps
  // held/dispatched back to available.
  async clearDispatch(): Promise<
    { cleared: true; was: "held" | "dispatched" } | { cleared: false }
  > {
    const { state } = await this._state();
    if (!state.dispatched_for && !state.held_for) return { cleared: false };
    const was = state.dispatched_for ? "dispatched" : "held";
    const next: TechState = { ...state, updated_at: Date.now() };
    delete next.dispatched_for;
    delete next.held_for;
    if (next.status === "dispatched" || next.status === "held") {
      next.status = "available";
    }
    await this.ctx.storage.put("state", next);
    await this._rearm(next);
    return { cleared: true, was };
  }

  async setShift(on: boolean): Promise<TechState> {
    const { state } = await this._state();
    const hadTimer = state.held_for !== undefined || state.dispatched_for !== undefined;
    const next: TechState = { ...state, status: on ? "available" : "off_shift", updated_at: Date.now() };
    delete next.held_for;
    delete next.dispatched_for;
    await this.ctx.storage.put("state", next);
    if (hadTimer) await this.ctx.storage.deleteAlarm();
    return next;
  }

  // Alarm delivery is at-least-once: this must be idempotent. Re-arms to
  // whichever of hold / dispatch expires first.
  async alarm(_info?: AlarmInfo): Promise<void> {
    const { state, cleared } = await this._state();
    if (state.held_for || state.dispatched_for) {
      await this._rearm(state);
      return;
    }
    if (cleared) {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
