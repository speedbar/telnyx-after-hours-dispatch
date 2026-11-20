// src/routes/tech.ts
// POST /admin/tech — guarded admin route that invokes one TechnicianActor
// method (reserve, release, status, setShift, clearDispatch) by tech_id, for
// ops and the concurrency script. Auth and logging mirror src/routes/seed.ts:
// the x-admin-token header is compared in constant time and never logged.

import { readConfig } from "../lib/config";
import { log, newRequestId } from "../lib/log";
import { tokenEqual } from "./seed";

// Local structural type for the TECH actor stub (same pattern as SeedStub).
export interface TechStub {
  reserve(args: unknown): Promise<unknown>;
  release(args: unknown): Promise<unknown>;
  status(): Promise<unknown>;
  setShift(on: boolean): Promise<unknown>;
  clearDispatch(): Promise<unknown>;
}

export interface TechEnv {
  TECH?: { idFromName(name: string): TechStub };
  [key: string]: unknown;
}

type TechMethod = "reserve" | "release" | "status" | "setShift" | "clearDispatch";

interface TechBody {
  tech_id: string;
  method: TechMethod;
  args?: unknown;
}

// Shape-check { tech_id, method, args? }. status and clearDispatch ignore
// args. Never throws.
function parseBody(raw: unknown): TechBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.tech_id !== "string" || body.tech_id === "") {
    return null;
  }
  const method = body.method;
  if (
    method !== "reserve" &&
    method !== "release" &&
    method !== "status" &&
    method !== "setShift" &&
    method !== "clearDispatch"
  ) {
    return null;
  }
  if (method === "reserve" || method === "release") {
    if (body.args === null || typeof body.args !== "object" || Array.isArray(body.args)) {
      return null;
    }
  }
  if (method === "setShift" && typeof body.args !== "boolean") {
    return null;
  }
  return { tech_id: body.tech_id, method, args: body.args };
}

export async function handleTech(
  request: Request,
  env: TechEnv,
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
      event: "tech_fail",
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

  // One try block: a missing TECH binding or a throwing actor both land here.
  try {
    const binding = env.TECH;
    if (binding === undefined) {
      throw new Error("tech_binding_missing");
    }
    const stub = binding.idFromName(body.tech_id);
    let result: unknown;
    switch (body.method) {
      case "reserve":
        result = await stub.reserve(body.args);
        break;
      case "release":
        result = await stub.release(body.args);
        break;
      case "status":
        result = await stub.status();
        break;
      case "setShift":
        result = await stub.setShift(body.args as boolean);
        break;
      case "clearDispatch":
        result = await stub.clearDispatch();
        break;
    }
    return Response.json({ ok: true, result }, { status: 200 });
  } catch (err) {
    log({
      component: "ops",
      event: "tech_fail",
      level: "error",
      request_id,
      outcome: "fail",
      error: err instanceof Error ? err.name : "unknown",
    });
    return Response.json({ ok: false, error: "actor_failed" }, { status: 500 });
  }
}
