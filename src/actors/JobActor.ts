// src/actors/JobActor.ts
// One job record per call; the actor instance name is the call_ref, so
// idempotency by call_ref falls out of the actor name (D13: hot-path state in
// actors, never KV). Every method does at most one storage get and one put.

import { StatefulActor } from "@telnyx/edge-runtime";
import { readConfig } from "../lib/config";
import { log } from "../lib/log.js";
import {
  initRingState,
  reduceRing,
  type RingEffect,
  type RingEvent,
  type RingState,
} from "../lib/ring.js";

type JobState = "reserved" | "briefed" | "released";
// D20: where the technician ring stands; JobState stays untouched (spec 1.1).
type DispatchState = "ringing" | "dispatched" | "unassigned";

interface JobRecord {
  call_ref: string;
  job_id: string;
  tech_id: string;
  state: JobState;
  urgency: string;
  trade: string;
  suburb: string;
  summary: string;
  customer_name?: string;
  address?: string;
  contact_phone?: string;
  details?: string;
  hazards?: string;
  release_reason?: string;
  flags?: string[]; // soft-validation flag names for human review; names only
  ring?: RingState; // D20: per-job ring state machine snapshot
  dispatch_state?: DispatchState;
  retention_at?: number; // ms epoch; absent on pre-D20 records means due now
  ring_at?: number; // ms epoch when the ring start is due (multiplexed alarm)
  created_at: number;
  updated_at: number;
}

type OpenResult =
  | { ok: true; state: JobState; created: boolean }
  | { ok: false; reason: "invalid_input" | "job_mismatch" | "already_closed" };

type BriefResult =
  | { ok: true; state: "briefed" }
  | { ok: false; reason: "invalid_input" | "no_active_reservation" };

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

// Retention of personal data on the job record (S1.8): default 7 days,
// JOB_RETENTION_DAYS accepts integers 1 to 90. Never logged.
function retentionDays(env: unknown): number {
  const raw = readConfig(env, "JOB_RETENTION_DAYS");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 7;
}

export class JobActor extends StatefulActor {
  private _callRef(): string {
    const id = (this.ctx as { id?: unknown }).id;
    return typeof id === "string" && id ? id : "call";
  }

  async open(args: {
    job_id: string;
    tech_id: string;
    urgency: string;
    trade: string;
    suburb: string;
    summary: string;
    flags?: string[];
    customer_name?: string;
    address?: string;
    contact_phone?: string;
  }): Promise<OpenResult> {
    const valid =
      nonEmpty(args.job_id) &&
      nonEmpty(args.tech_id) &&
      nonEmpty(args.urgency) &&
      nonEmpty(args.trade) &&
      nonEmpty(args.suburb) &&
      nonEmpty(args.summary);
    if (!valid) {
      log({ component: "actor", event: "job_rejected", outcome: "rejected", call_ref: this._callRef(), error: "invalid_input" });
      return { ok: false, reason: "invalid_input" };
    }
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec) {
      const now = Date.now();
      const retention_at = now + retentionDays(this.env) * 86_400_000;
      const record: JobRecord = {
        call_ref: this._callRef(),
        job_id: args.job_id,
        tech_id: args.tech_id,
        state: "reserved",
        urgency: args.urgency,
        trade: args.trade,
        suburb: args.suburb,
        summary: args.summary,
        retention_at,
        created_at: now,
        updated_at: now,
      };
      // Confirmed at reservation (3b): personal data, never logged; the
      // retention alarm below covers it.
      if (args.flags !== undefined && args.flags.length > 0) record.flags = args.flags;
      if (args.customer_name !== undefined) record.customer_name = args.customer_name;
      if (args.address !== undefined) record.address = args.address;
      if (args.contact_phone !== undefined) record.contact_phone = args.contact_phone;
      await this.ctx.storage.put("job", record);
      await this.ctx.storage.setAlarm(retention_at);
      log({ component: "actor", event: "job_opened", outcome: "ok", technician_id: record.tech_id, job_id: record.job_id, call_ref: record.call_ref, flags: (args.flags ?? []).join(",") });
      return { ok: true, state: "reserved", created: true };
    }
    if (rec.job_id !== args.job_id) {
      log({ component: "actor", event: "job_rejected", outcome: "rejected", technician_id: rec.tech_id, job_id: args.job_id, call_ref: this._callRef(), error: "job_mismatch" });
      return { ok: false, reason: "job_mismatch" };
    }
    if (rec.state === "released") {
      log({ component: "actor", event: "job_rejected", outcome: "rejected", technician_id: rec.tech_id, job_id: rec.job_id, call_ref: this._callRef(), error: "already_closed" });
      return { ok: false, reason: "already_closed" };
    }
    return { ok: true, state: rec.state, created: false };
  }

  async brief(args: {
    job_id: string;
    customer_name: string;
    address: string;
    contact_phone?: string;
    details: string;
    hazards?: string;
  }): Promise<BriefResult> {
    const valid =
      nonEmpty(args.customer_name) &&
      nonEmpty(args.address) &&
      nonEmpty(args.details) &&
      (args.contact_phone === undefined || typeof args.contact_phone === "string") &&
      (args.hazards === undefined || typeof args.hazards === "string");
    if (!valid) {
      log({ component: "actor", event: "job_rejected", outcome: "rejected", job_id: args.job_id, call_ref: this._callRef(), error: "invalid_input" });
      return { ok: false, reason: "invalid_input" };
    }
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec || rec.job_id !== args.job_id || rec.state === "released") {
      const fields = {
        component: "actor" as const,
        event: "job_rejected",
        outcome: "rejected" as const,
        job_id: args.job_id,
        call_ref: this._callRef(),
        error: "no_active_reservation",
        ...(rec ? { technician_id: rec.tech_id } : {}),
      };
      log(fields);
      return { ok: false, reason: "no_active_reservation" };
    }
    // First write wins (S1.8): an already briefed job is never overwritten.
    if (rec.state === "briefed") {
      return { ok: true, state: "briefed" };
    }
    const next: JobRecord = {
      ...rec,
      customer_name: args.customer_name,
      address: args.address,
      details: args.details,
      state: "briefed",
      updated_at: Date.now(),
    };
    // The callback confirmed and normalised at reservation wins (3b).
    if (rec.contact_phone === undefined && args.contact_phone !== undefined) {
      next.contact_phone = args.contact_phone;
    }
    if (args.hazards !== undefined) next.hazards = args.hazards;
    await this.ctx.storage.put("job", next);
    log({ component: "actor", event: "job_briefed", outcome: "ok", technician_id: rec.tech_id, job_id: rec.job_id, call_ref: this._callRef() });
    return { ok: true, state: "briefed" };
  }

  async release(args: { job_id: string; reason: string }): Promise<{ released: boolean }> {
    try {
      const rec = await this.ctx.storage.get<JobRecord>("job");
      if (!rec || rec.job_id !== args.job_id || rec.state === "released") {
        return { released: false };
      }
      const next: JobRecord = { ...rec, state: "released", release_reason: args.reason, updated_at: Date.now() };
      await this.ctx.storage.put("job", next);
      log({ component: "actor", event: "job_released", outcome: "ok", technician_id: rec.tech_id, job_id: rec.job_id, call_ref: this._callRef() });
      return { released: true };
    } catch {
      return { released: false };
    }
  }

  async get(): Promise<JobRecord | null> {
    return (await this.ctx.storage.get<JobRecord>("job")) ?? null;
  }

  // Re-arm the one alarm (D20 multiplex) to whichever of retention / ring
  // start comes first; with neither pending there is nothing to wake for.
  private async _rearm(rec: JobRecord): Promise<void> {
    const times = [rec.retention_at, rec.ring_at].filter(
      (t): t is number => t !== undefined,
    );
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  // D20: schedule the ring start on the multiplexed alarm (spec 1.2).
  async setRingAt(ms: number): Promise<{ ok: boolean }> {
    if (!Number.isFinite(ms)) return { ok: false };
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec) return { ok: false };
    rec.ring_at = ms;
    rec.updated_at = Date.now();
    await this.ctx.storage.put("job", rec);
    await this._rearm(rec);
    return { ok: true };
  }

  // D20: one read-modify-write around the pure reducer — the new ring state
  // and any job_state effect landing on dispatch_state are stored together,
  // so a crash between them cannot split the two. Effects return as data for
  // the caller to execute.
  async ringEvent(
    event: RingEvent,
  ): Promise<{ state: RingState | null; effects: RingEffect[] }> {
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec) return { state: null, effects: [] };
    const [nextRing, effects] = reduceRing(rec.ring ?? initRingState(), event);
    const next: JobRecord = { ...rec, ring: nextRing, updated_at: Date.now() };
    let hasJobState = false;
    for (const e of effects) {
      if (e.type === "job_state") {
        next.dispatch_state = e.state;
        hasJobState = true;
      }
    }
    // D20-2: while an attempt is in flight the job is ringing; a job_state
    // effect (dispatched / unassigned) always wins over this default.
    if (
      !hasJobState &&
      (nextRing.status === "dialing" || nextRing.status === "reserving" || nextRing.status === "prompting")
    ) {
      next.dispatch_state = "ringing";
    }
    await this.ctx.storage.put("job", next);
    return { state: nextRing, effects };
  }

  // Multiplexed alarm (D20): a due retention deletes the job record; a due
  // ring_at is consumed (the dial itself is wired in D20-5) and never deletes.
  // At-least-once delivery: every path is idempotent; a repeat is a no-op.
  async alarm(): Promise<void> {
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec) return; // already deleted: harmless repeat
    const now = Date.now();
    // Pre-D20 records carry no retention_at; their only alarm was retention.
    if ((rec.retention_at ?? 0) <= now) {
      await this.ctx.storage.delete("job");
      log({ component: "actor", event: "job_expired", outcome: "ok", call_ref: this._callRef() });
      return;
    }
    if (rec.ring_at !== undefined && rec.ring_at <= now) {
      delete rec.ring_at;
      rec.updated_at = now;
      await this.ctx.storage.put("job", rec);
      log({ component: "actor", event: "ring_alarm_due", outcome: "ok", call_ref: this._callRef(), job_id: rec.job_id });
    }
    await this._rearm(rec);
  }
}
