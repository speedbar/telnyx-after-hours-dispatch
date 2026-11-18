// src/routes/seed.ts
// POST /admin/seed — guarded admin route that seeds the DirectoryActor
// (hot-path copy, D13) and then KV (durable copy, written one entry at a
// time). KV is slow (~2 s per put), so this route may take several seconds;
// that is fine for an admin call, and a KV failure is counted, not fatal.
// Auth: the x-admin-token header must equal the ADMIN_TOKEN secret
// (constant-time compare, length check first). Never logs the token, phone
// numbers or record contents.
// Note: the seed_done counts are embedded in the event string because
// LogFields (src/lib/log.ts, which this task may not edit) has no count
// fields; the counts are also in the JSON response.

import { readConfig } from "../lib/config";
import { keys } from "../lib/kv-keys";
import { log, newRequestId } from "../lib/log";

// Local structural type for the DIRECTORY actor stub (telnyx-env.d.ts is
// generated and may lag telnyx.toml — see the note in src/routes/dv.ts).
export interface SeedStub {
  seed(entries: Array<{ key: string; value: string }>): Promise<number>;
}

export interface SeedEnv {
  // DIRECTORY is optional in the TYPE only (see DvEnv); the route requires
  // it and the KV binding at runtime.
  DIRECTORY?: { idFromName(name: string): SeedStub };
  DISPATCH_KV: { put(key: string, value: string): Promise<void> };
  [key: string]: unknown;
}

interface SeedBody {
  customers: Array<{ phone: string; record: Record<string, unknown> }>;
  flags: Record<string, string>;
}

// Constant-time token comparison; the length check runs first (different
// lengths leak nothing beyond what the response already says).
export function tokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Shape-check the documented body: { customers: [{phone, record}], flags:
// { name: value } }. Anything else is bad_body. Never throws.
function parseBody(raw: unknown): SeedBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const customers = body.customers;
  const flags = body.flags;
  if (!Array.isArray(customers)) {
    return null;
  }
  for (const item of customers) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const customer = item as Record<string, unknown>;
    if (typeof customer.phone !== "string") {
      return null;
    }
    if (
      customer.record === null ||
      typeof customer.record !== "object" ||
      Array.isArray(customer.record)
    ) {
      return null;
    }
  }
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) {
    return null;
  }
  for (const value of Object.values(flags)) {
    if (typeof value !== "string") {
      return null;
    }
  }
  return {
    customers: customers as SeedBody["customers"],
    flags: flags as Record<string, string>,
  };
}

export async function handleSeed(
  request: Request,
  env: SeedEnv,
): Promise<Response> {
  const request_id = newRequestId();

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  const expected = readConfig(env, "ADMIN_TOKEN");
  const provided = request.headers.get("x-admin-token");
  if (expected === undefined || provided === null || !tokenEqual(provided, expected)) {
    log({
      component: "ops",
      event: "seed_fail",
      level: "warn",
      request_id,
      outcome: "rejected",
    });
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  const body = parseBody(raw);
  if (body === null) {
    return Response.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  // Build the entries: cust/<digits> -> JSON record, flag/<name> -> value.
  // An unusable phone or flag name is the body's fault (400).
  let entries: Array<{ key: string; value: string }>;
  try {
    entries = [
      ...body.customers.map((c) => ({
        key: keys.customer(c.phone),
        value: JSON.stringify(c.record),
      })),
      ...Object.entries(body.flags).map(([name, value]) => ({
        key: keys.flag(name),
        value,
      })),
    ];
  } catch {
    return Response.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  const stub = env.DIRECTORY?.idFromName("directory");
  if (stub === undefined) {
    log({
      component: "ops",
      event: "seed_fail",
      level: "error",
      request_id,
      outcome: "fail",
      error: "directory_unavailable",
    });
    return Response.json({ ok: false, error: "seed_failed" }, { status: 500 });
  }

  // Step 1: the hot-path copy. A seed() failure aborts the whole route (the
  // actor validates every key before writing anything, so nothing partial
  // is stored).
  let actor_count: number;
  try {
    actor_count = await stub.seed(entries);
  } catch (err) {
    log({
      component: "ops",
      event: "seed_fail",
      level: "error",
      request_id,
      outcome: "fail",
      error: "seed_failed:" + (err instanceof Error ? err.name : "unknown"),
    });
    return Response.json({ ok: false, error: "seed_failed" }, { status: 500 });
  }

  // Step 2: the durable KV copy, one entry at a time. A failed put is
  // counted and the rest still go through — this copy is off the hot path.
  let kv_ok = 0;
  let kv_failed = 0;
  for (const entry of entries) {
    try {
      await env.DISPATCH_KV.put(entry.key, entry.value);
      kv_ok += 1;
    } catch {
      kv_failed += 1;
    }
  }

  log({
    component: "ops",
    event: `seed_done actor_count=${actor_count} kv_ok=${kv_ok} kv_failed=${kv_failed}`,
    request_id,
    outcome: kv_failed > 0 ? "degraded" : "ok",
  });
  return Response.json(
    { ok: true, actor_count, kv_ok, kv_failed },
    { status: 200 },
  );
}
