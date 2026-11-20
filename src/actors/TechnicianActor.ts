import { StatefulActor, type AlarmInfo } from "@telnyx/edge-runtime";
import { log } from "../lib/log.js";

type TechStatus = "available" | "held" | "off_shift";

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
  updated_at: number;
}

type ReserveResult =
  | { ok: true; expires_at: number }
  | { ok: false; reason: "busy" | "off_shift" | "invalid_input" };

export class TechnicianActor extends StatefulActor {
  async ping(): Promise<{ pong: boolean; count: number }> {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return { pong: true, count };
  }

  // Read state once; lazily clear an expired hold. A lapse logs exactly one
  // hold_expired line (technician id + hold length in latency_ms): the cleared
  // state is persisted here so no later read can log it again (S1.9e). A hold
  // already consumed by create_job (booked) is swept silently.
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
    if (state.held_for && state.held_for.expires_at <= Date.now()) {
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
      state.updated_at = Date.now();
      await this.ctx.storage.put("state", state);
      return { state, cleared: true };
    }
    return { state, cleared: false };
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
      await this.ctx.storage.deleteAlarm();
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

  async setShift(on: boolean): Promise<TechState> {
    const { state } = await this._state();
    const hadHold = state.held_for !== undefined;
    const next: TechState = { ...state, status: on ? "available" : "off_shift", updated_at: Date.now() };
    delete next.held_for;
    await this.ctx.storage.put("state", next);
    if (hadHold) await this.ctx.storage.deleteAlarm();
    return next;
  }

  // Alarm delivery is at-least-once: this must be idempotent.
  async alarm(_info?: AlarmInfo): Promise<void> {
    const { state, cleared } = await this._state();
    if (state.held_for) {
      await this.ctx.storage.setAlarm(state.held_for.expires_at);
      return;
    }
    if (cleared) {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
