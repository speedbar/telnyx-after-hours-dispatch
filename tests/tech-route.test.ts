// tests/tech-route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTech, type TechEnv, type TechStub } from "../src/routes/tech.js";

const TOKEN = "tech-admin-token-for-tests";

interface Call {
  name: string;
  method: string;
  args: unknown;
}

interface Fakes {
  env: TechEnv;
  calls: Call[];
}

// TECH fake recording every call; throwOn makes that method reject.
function makeFakes(throwOn?: string): Fakes {
  const calls: Call[] = [];
  const record = (method: string, args: unknown, result: unknown) => {
    calls.push({ name: "tech-01", method, args });
    if (throwOn === method) {
      return Promise.reject(new TypeError("boom secret message"));
    }
    return Promise.resolve(result);
  };
  const stub: TechStub = {
    reserve: (args) => record("reserve", args, { ok: true, held: true }),
    release: (args) => record("release", args, { ok: true, released: true }),
    status: () => record("status", undefined, { ok: true, on_shift: true }),
    setShift: (on) => record("setShift", on, { ok: true, on_shift: on }),
    clearDispatch: () => record("clearDispatch", undefined, { cleared: true }),
  };
  const env: TechEnv = {
    ADMIN_TOKEN: TOKEN,
    TECH: { idFromName: (name: string) => (calls.push({ name, method: "idFromName", args: undefined }), stub) },
  };
  return { env, calls };
}

function techRequest(body?: string, token?: string, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) {
    headers["x-admin-token"] = token;
  }
  return new Request("https://test.invalid/admin/tech", { method, body, headers });
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: unknown) => {
    lines.push(String(msg));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("1. no token header: 403 forbidden and a tech_fail warn log", async () => {
  const { env, calls } = makeFakes();
  const cap = captureLog();
  try {
    const body = JSON.stringify({ tech_id: "tech-01", method: "status" });
    const res = await handleTech(techRequest(body), env);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    assert.equal(calls.length, 0, "the actor must not be touched");
    const fail = parsed(cap.lines).find((l) => l.event === "tech_fail");
    assert.ok(fail, "expected a tech_fail log line");
    assert.equal(fail.level, "warn");
    assert.equal(fail.outcome, "rejected");
    assert.equal(fail.component, "ops");
  } finally {
    cap.restore();
  }
});

test("2. wrong token (same length): 403 forbidden", async () => {
  const { env, calls } = makeFakes();
  const cap = captureLog();
  try {
    const wrong = TOKEN.slice(0, -1) + "x";
    const body = JSON.stringify({ tech_id: "tech-01", method: "status" });
    const res = await handleTech(techRequest(body, wrong), env);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    assert.equal(calls.length, 0);
    assert.ok(parsed(cap.lines).some((l) => l.event === "tech_fail"));
  } finally {
    cap.restore();
  }
});

test("3. GET request: 405 method_not_allowed, no log line", async () => {
  const { env } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleTech(techRequest(undefined, TOKEN, "GET"), env);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: "method_not_allowed",
    });
    assert.equal(cap.lines.length, 0);
  } finally {
    cap.restore();
  }
});

test("4. bad JSON and bad shapes: 400 bad_body, actor untouched", async () => {
  const { env, calls } = makeFakes();
  const cap = captureLog();
  try {
    const bads = [
      "{not json",
      JSON.stringify({ tech_id: "tech-01", method: "reserve" }), // args missing
      JSON.stringify({ tech_id: "tech-01", method: "reserve", args: 42 }),
      JSON.stringify({ tech_id: "tech-01", method: "release", args: [1] }),
      JSON.stringify({ tech_id: "tech-01", method: "setShift", args: {} }),
      JSON.stringify({ tech_id: "", method: "status" }),
      JSON.stringify({ method: "status" }),
    ];
    for (const bad of bads) {
      const res = await handleTech(techRequest(bad, TOKEN), env);
      assert.equal(res.status, 400, bad);
      assert.deepEqual(await res.json(), { ok: false, error: "bad_body" });
    }
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
  }
});

test("5. unknown method: 400 bad_body", async () => {
  const { env, calls } = makeFakes();
  const cap = captureLog();
  try {
    const body = JSON.stringify({ tech_id: "tech-01", method: "ping", args: {} });
    const res = await handleTech(techRequest(body, TOKEN), env);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "bad_body" });
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
  }
});

test("6. each method reaches the stub by tech_id and returns its result", async () => {
  const { env, calls } = makeFakes();
  const cap = captureLog();
  try {
    const reserveArgs = { call_ref: "cr-1", job_id: "j-1", ttl_s: 5 };
    const cases: Array<{ method: string; args?: unknown; expected: unknown }> = [
      { method: "reserve", args: reserveArgs, expected: { ok: true, held: true } },
      { method: "release", args: { call_ref: "cr-1" }, expected: { ok: true, released: true } },
      { method: "status", expected: { ok: true, on_shift: true } },
      { method: "setShift", args: true, expected: { ok: true, on_shift: true } },
      { method: "clearDispatch", expected: { cleared: true } },
    ];
    for (const c of cases) {
      const body = JSON.stringify({ tech_id: "tech-01", method: c.method, args: c.args });
      const res = await handleTech(techRequest(body, TOKEN), env);
      assert.equal(res.status, 200, c.method);
      assert.deepEqual(await res.json(), { ok: true, result: c.expected });
    }
    const byMethod = (m: string) => calls.find((c) => c.method === m);
    assert.equal(byMethod("idFromName")?.name, "tech-01");
    assert.deepEqual(byMethod("reserve")?.args, reserveArgs);
    assert.deepEqual(byMethod("release")?.args, { call_ref: "cr-1" });
    assert.equal(byMethod("status")?.args, undefined);
    assert.equal(byMethod("setShift")?.args, true);
    assert.equal(byMethod("clearDispatch")?.args, undefined);
  } finally {
    cap.restore();
  }
});

test("7. stub throws: 500 actor_failed, error log carries the name only", async () => {
  const { env } = makeFakes("reserve");
  const cap = captureLog();
  try {
    const body = JSON.stringify({
      tech_id: "tech-01",
      method: "reserve",
      args: { call_ref: "cr-1" },
    });
    const res = await handleTech(techRequest(body, TOKEN), env);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: "actor_failed" });
    const fail = parsed(cap.lines).find((l) => l.event === "tech_fail");
    assert.ok(fail, "expected a tech_fail log line");
    assert.equal(fail.level, "error");
    assert.equal(fail.outcome, "fail");
    assert.equal(fail.error, "TypeError");
    assert.ok(!String(fail.error).includes("boom"), "name only, not the message");
  } finally {
    cap.restore();
  }
});

test("8. missing TECH binding: 500 actor_failed", async () => {
  const cap = captureLog();
  try {
    const env: TechEnv = { ADMIN_TOKEN: TOKEN };
    const body = JSON.stringify({ tech_id: "tech-01", method: "status" });
    const res = await handleTech(techRequest(body, TOKEN), env);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: "actor_failed" });
    const fail = parsed(cap.lines).find((l) => l.event === "tech_fail");
    assert.equal(fail?.level, "error");
    assert.equal(fail?.outcome, "fail");
    assert.equal(fail?.error, "Error");
  } finally {
    cap.restore();
  }
});

test("9. privacy: no token in any log line", async () => {
  const { env } = makeFakes("reserve");
  const cap = captureLog();
  try {
    const body = JSON.stringify({
      tech_id: "tech-01",
      method: "reserve",
      args: { call_ref: "cr-1" },
    });
    const res = await handleTech(techRequest(body, TOKEN), env);
    assert.equal(res.status, 500);
    const forbidden = await handleTech(techRequest(body, "wrong-token-xyz"), env);
    assert.equal(forbidden.status, 403);
    const joined = cap.lines.join("\n");
    assert.ok(!joined.includes(TOKEN), "no log line may contain the token");
    assert.ok(
      !joined.includes("wrong-token-xyz"),
      "no log line may contain the presented token",
    );
  } finally {
    cap.restore();
  }
});
