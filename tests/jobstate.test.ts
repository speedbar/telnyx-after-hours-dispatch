// tests/jobstate.test.ts
// POST /admin/job-state route tests: fake JOBS actor; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleJobState,
  type JobStateEnv,
  type JobStateStub,
} from "../src/routes/jobstate.js";

const TOKEN = "job-state-admin-token";

interface Calls {
  names: string[];
  gets: number;
}

function makeFakes(record: Record<string, unknown> | null): {
  env: JobStateEnv;
  calls: Calls;
} {
  const calls: Calls = { names: [], gets: 0 };
  const stub: JobStateStub = {
    get: async () => {
      calls.gets += 1;
      return record as Awaited<ReturnType<JobStateStub["get"]>>;
    },
  };
  const env: JobStateEnv = {
    ADMIN_TOKEN: TOKEN,
    JOBS: {
      idFromName: (name: string) => {
        calls.names.push(name);
        return stub;
      },
    },
  };
  return { env, calls };
}

function req(body?: string, token?: string, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-admin-token"] = token;
  return new Request("https://test.invalid/admin/job-state", { method, body, headers });
}

function captureLog(): { lines: Array<Record<string, unknown>>; restore: () => void } {
  const lines: Array<Record<string, unknown>> = [];
  const orig = console.log;
  console.log = (msg: unknown) => {
    lines.push(JSON.parse(String(msg)) as Record<string, unknown>);
  };
  return { lines, restore: () => (console.log = orig) };
}

test("auth: missing or wrong token -> 403 forbidden, no actor call", async () => {
  for (const token of [undefined, "wrong-token-xyz"]) {
    const { env, calls } = makeFakes(null);
    const cap = captureLog();
    try {
      const res = await handleJobState(req(JSON.stringify({ call_ref: "call-1" }), token), env);
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
      assert.equal(calls.names.length, 0, "no actor touched");
      assert.equal(calls.gets, 0, "no actor touched");
      const fail = cap.lines.find((l) => l.event === "job_state_fail");
      assert.equal(fail?.outcome, "rejected");
    } finally {
      cap.restore();
    }
  }
});

test("no record -> found:false", async () => {
  const { env, calls } = makeFakes(null);
  const cap = captureLog();
  try {
    const res = await handleJobState(req(JSON.stringify({ call_ref: "call-2" }), TOKEN), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, found: false });
    assert.equal(calls.gets, 1);
  } finally {
    cap.restore();
  }
});

test("job with ring state: expected fields, hashed actor name, no PII", async () => {
  const past = Date.now() - 60_000;
  const record = {
    call_ref: "c:dummy",
    job_id: "JA4F7C",
    tech_id: "tech-01",
    state: "reserved",
    dispatch_state: "ringing",
    urgency: "emergency",
    trade: "plumbing",
    suburb: "Simville",
    summary: "Burst pipe flooding the kitchen",
    customer_name: "Jane Citizen",
    address: "12 Fake Street, Simville",
    contact_phone: "61400111222",
    details: "Knee-deep water by the stove",
    retention_at: past + 7 * 86_400_000,
    ring_at: past,
    ring_alarm_ran_at: past + 500,
    ring_start_reason: "ok",
    ring: {
      mode: "dry_run",
      status: "prompting",
      attempt: 1,
      tried: ["tech-01"],
      outcome_log: [
        { technician_id: "tech-09", outcome: "no_answer", at: past },
        { technician_id: "tech-01", outcome: "declined", at: past + 1000 },
      ],
      candidates: ["tech-09", "tech-01"],
      seen_event_ids: ["e1"],
    },
    created_at: past - 100,
    updated_at: past,
  };
  const { env, calls } = makeFakes(record);
  const cap = captureLog();
  try {
    const res = await handleJobState(req(JSON.stringify({ call_ref: "call-3" }), TOKEN), env);
    assert.equal(res.status, 200);
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;

    assert.equal(json.ok, true);
    assert.equal(json.found, true);
    assert.equal(json.job_id, "JA4F7C");
    assert.equal(json.state, "reserved");
    assert.equal(json.dispatch_state, "ringing");
    assert.equal(json.ring_status, "prompting");
    assert.equal(json.ring_attempt, 1);
    assert.deepEqual(json.ring_tried, ["tech-01"]);
    assert.deepEqual(json.ring_outcomes, [
      { technician_id: "tech-09", outcome: "no_answer", at: past },
      { technician_id: "tech-01", outcome: "declined", at: past + 1000 },
    ]);
    assert.equal(json.ring_at_pending, true);
    assert.equal(json.ring_at_overdue, true);
    assert.equal(json.retention_at, past + 7 * 86_400_000);
    assert.equal(json.ring_alarm_ran_at, past + 500);
    assert.equal(json.ring_start_reason, "ok");

    // Actor name resolved via resolveCallRef (hashed), never the raw value.
    assert.match(calls.names[0], /^c:[0-9a-f]{32}$/);

    // No phone digits, name or address from the fixture anywhere in the body.
    assert.ok(!text.includes("61400111222"), "no contact phone digits");
    assert.ok(!text.includes("Jane Citizen"), "no customer name");
    assert.ok(!text.includes("Fake Street"), "no address");
    assert.ok(!text.includes("Burst pipe"), "no summary");
    assert.ok(!text.includes("Knee-deep"), "no brief details");
  } finally {
    cap.restore();
  }
});
