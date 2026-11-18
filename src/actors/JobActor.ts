// src/actors/JobActor.ts
// One job record per call; the actor instance name is the call_ref, so
// idempotency by call_ref falls out of the actor name (D13: hot-path state in
// actors, never KV). Every method does at most one storage get and one put.

import { StatefulActor } from "@telnyx/edge-runtime";
import { log } from "../lib/log.js";

type JobState = "reserved" | "briefed" | "released";

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
      const record: JobRecord = {
        call_ref: this._callRef(),
        job_id: args.job_id,
        tech_id: args.tech_id,
        state: "reserved",
        urgency: args.urgency,
        trade: args.trade,
        suburb: args.suburb,
        summary: args.summary,
        created_at: now,
        updated_at: now,
      };
      await this.ctx.storage.put("job", record);
      log({ component: "actor", event: "job_opened", outcome: "ok", technician_id: record.tech_id, job_id: record.job_id, call_ref: record.call_ref });
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
    const next: JobRecord = {
      ...rec,
      customer_name: args.customer_name,
      address: args.address,
      details: args.details,
      state: "briefed",
      updated_at: Date.now(),
    };
    if (args.contact_phone !== undefined) next.contact_phone = args.contact_phone;
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
}
