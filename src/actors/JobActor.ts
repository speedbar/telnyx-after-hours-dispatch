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
import type { RingStartReason } from "../lib/ringstart";
import { tokenEqual } from "../routes/seed";

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
  ring_alarm_ran_at?: number; // D20-5d: ms epoch the ring-start alarm last ran
  ring_start_reason?: RingStartReason; // D20-5d: why that start (did not) run
  // D20-5e: single-use token + absolute callback URL for POST /ring-start.
  // Never logged, never returned anywhere; the token is deleted on use.
  ring_token?: string;
  ring_cb?: string;
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

  // D20: schedule the ring start on the multiplexed alarm (spec 1.2). D20-5e:
  // the single-use callback token and URL are stored beside ring_at for the
  // alarm's POST to the function (present only from create_job's success path).
  async setRingAt(
    ms: number,
    ring?: { token: string; cb?: string },
  ): Promise<{ ok: boolean }> {
    if (!Number.isFinite(ms)) return { ok: false };
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec) return { ok: false };
    rec.ring_at = ms;
    if (ring !== undefined) {
      rec.ring_token = ring.token;
      if (ring.cb !== undefined) rec.ring_cb = ring.cb;
    }
    rec.updated_at = Date.now();
    await this.ctx.storage.put("job", rec);
    await this._rearm(rec);
    return { ok: true };
  }

  // D20-5e: atomic single-use check of the ring-start callback token. True
  // only when the token matches (constant time) AND the ring is idle or
  // unset; on true the token is deleted, so a replay (or a ring already
  // started) can never start a second dial. Anything else is false.
  async consumeRingToken(token: string): Promise<boolean> {
    const rec = await this.ctx.storage.get<JobRecord>("job");
    if (!rec || typeof rec.ring_token !== "string") return false;
    const status = rec.ring === undefined ? "idle" : rec.ring.status;
    if (status !== "idle") return false;
    if (!tokenEqual(token, rec.ring_token)) return false;
    delete rec.ring_token;
    rec.updated_at = Date.now();
    await this.ctx.storage.put("job", rec);
    return true;
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
  // ring_at is consumed FIRST (so a redelivered alarm cannot POST twice).
  // D20-5e: the alarm keeps only the timing — the dial runs in the FUNCTION,
  // which has the ring secrets the actor does not appear to see (V-020), so
  // the alarm POSTs the stored callback URL with the single-use token and
  // stamps the response reason. At-least-once delivery: every path is
  // idempotent; a repeat is a no-op. The alarm never throws.
  async alarm(): Promise<void> {
    let rec = await this.ctx.storage.get<JobRecord>("job");
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
      // POST the stored callback (3000 ms timeout). The token goes in the
      // body only and is never logged. Any failure (no callback stored,
      // fetch throw, timeout, non-200, a body without ok+reason) is the
      // single visible reason callback_error.
      let reason: RingStartReason = "callback_error";
      if (rec.ring_cb !== undefined && rec.ring_token !== undefined) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => {
            ctrl.abort();
          }, 3000);
          let res: Response;
          try {
            res = await fetch(rec.ring_cb, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                call_ref: this._callRef(),
                token: rec.ring_token,
              }),
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (res.status === 200) {
            const data = (await res.json()) as { ok?: unknown; reason?: unknown };
            if (data.ok === true && typeof data.reason === "string") {
              reason = data.reason as RingStartReason;
            }
          }
        } catch {
          reason = "callback_error";
        }
      }
      // D20-5d: stamp why the start (did not) run. Re-read first: a start
      // that ran wrote ring state via ringEvent, so rec is stale here. A
      // failed or missing callback (not ok, not mode_off) also flips an
      // otherwise-unset dispatch_state to unassigned — never silently briefed.
      const fresh = await this.ctx.storage.get<JobRecord>("job");
      if (fresh) {
        fresh.ring_alarm_ran_at = Date.now();
        fresh.ring_start_reason = reason;
        if (reason !== "ok" && reason !== "mode_off" && fresh.dispatch_state === undefined) {
          fresh.dispatch_state = "unassigned";
        }
        fresh.updated_at = Date.now();
        await this.ctx.storage.put("job", fresh);
        rec = fresh;
      }
    }
    await this._rearm(rec);
  }
}
