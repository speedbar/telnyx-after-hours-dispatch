// tests/seed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSeed, type SeedEnv, type SeedStub } from "../src/routes/seed.js";

const TOKEN = "seed-admin-token-for-tests";
const PHONE = "+61491570006";
const PHONE_DIGITS = "61491570006";
const RECORD = { name: "Ada Lovelace", address: "12 Quay St, Wollongong" };

interface Fakes {
  env: SeedEnv;
  actorStore: Map<string, string>;
  kvStore: Map<string, string>;
  seedCalls: Array<Array<{ key: string; value: string }>>;
}

// DIRECTORY and KV fakes, both backed by Maps. kvFailOn makes those KV puts
// throw so the "KV failure is counted, not fatal" case can be exercised.
function makeFakes(kvFailOn: string[] = []): Fakes {
  const actorStore = new Map<string, string>();
  const kvStore = new Map<string, string>();
  const seedCalls: Array<Array<{ key: string; value: string }>> = [];
  const stub: SeedStub = {
    seed(entries) {
      seedCalls.push(entries);
      for (const entry of entries) {
        actorStore.set(entry.key, entry.value);
      }
      return Promise.resolve(entries.length);
    },
  };
  const env: SeedEnv = {
    ADMIN_TOKEN: TOKEN,
    DIRECTORY: { idFromName: () => stub },
    DISPATCH_KV: {
      put(key: string, value: string): Promise<void> {
        if (kvFailOn.includes(key)) {
          return Promise.reject(new Error("kv unavailable"));
        }
        kvStore.set(key, value);
        return Promise.resolve();
      },
    },
  };
  return { env, actorStore, kvStore, seedCalls };
}

function makeBody(): string {
  return JSON.stringify({
    customers: [{ phone: PHONE, record: RECORD }],
    flags: { dispatch_enabled: "true" },
  });
}

function seedRequest(body?: string, token?: string, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) {
    headers["x-admin-token"] = token;
  }
  return new Request("https://test.invalid/admin/seed", { method, body, headers });
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

test("1. no token header: 403 forbidden and a seed_fail log line", async () => {
  const { env, seedCalls } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleSeed(seedRequest(makeBody()), env);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    assert.equal(seedCalls.length, 0, "the actor must not be touched");
    const fail = parsed(cap.lines).find((l) => l.event === "seed_fail");
    assert.ok(fail, "expected a seed_fail log line");
    assert.equal(fail.level, "warn");
    assert.equal(fail.outcome, "rejected");
  } finally {
    cap.restore();
  }
});

test("2. wrong token: 403 forbidden, constant-time compare path", async () => {
  const { env, seedCalls } = makeFakes();
  const cap = captureLog();
  try {
    // Same length as TOKEN so the constant-time loop actually runs.
    const wrong = TOKEN.slice(0, -1) + "x";
    const res = await handleSeed(seedRequest(makeBody(), wrong), env);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
    assert.equal(seedCalls.length, 0);
    assert.ok(parsed(cap.lines).some((l) => l.event === "seed_fail"));
  } finally {
    cap.restore();
  }
});

test("3. GET request: 405 method_not_allowed", async () => {
  const { env } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleSeed(seedRequest(undefined, TOKEN, "GET"), env);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: "method_not_allowed",
    });
  } finally {
    cap.restore();
  }
});

test("4. bad body: 400 bad_body and nothing is written", async () => {
  const { env, actorStore, kvStore, seedCalls } = makeFakes();
  const cap = captureLog();
  try {
    const bad = JSON.stringify({ customers: "nope", flags: {} });
    const res = await handleSeed(seedRequest(bad, TOKEN), env);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "bad_body" });
    assert.equal(seedCalls.length, 0);
    assert.equal(actorStore.size, 0);
    assert.equal(kvStore.size, 0);
  } finally {
    cap.restore();
  }
});

test("5. correct token: writes to actor and KV, reports the counts", async () => {
  const { env, actorStore, kvStore, seedCalls } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleSeed(seedRequest(makeBody(), TOKEN), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      actor_count: 2,
      kv_ok: 2,
      kv_failed: 0,
    });
    // One actor seed call carrying the customer and the flag entries.
    assert.equal(seedCalls.length, 1);
    const entries = seedCalls[0];
    assert.deepEqual(
      entries.find((e) => e.key === `cust/${PHONE_DIGITS}`),
      { key: `cust/${PHONE_DIGITS}`, value: JSON.stringify(RECORD) },
    );
    assert.deepEqual(
      entries.find((e) => e.key === "flag/dispatch_enabled"),
      { key: "flag/dispatch_enabled", value: "true" },
    );
    // Both fakes received the same entries.
    assert.equal(actorStore.get(`cust/${PHONE_DIGITS}`), JSON.stringify(RECORD));
    assert.equal(actorStore.get("flag/dispatch_enabled"), "true");
    assert.equal(kvStore.get(`cust/${PHONE_DIGITS}`), JSON.stringify(RECORD));
    assert.equal(kvStore.get("flag/dispatch_enabled"), "true");
    // One seed_done log line carrying the counts.
    const done = parsed(cap.lines).find(
      (l) => typeof l.event === "string" && l.event.startsWith("seed_done"),
    );
    assert.ok(done, "expected a seed_done log line");
    assert.match(String(done.event), /actor_count=2/);
    assert.match(String(done.event), /kv_ok=2/);
    assert.match(String(done.event), /kv_failed=0/);
    assert.equal(done.outcome, "ok");
  } finally {
    cap.restore();
  }
});

test("6. a KV put failure is counted, not fatal", async () => {
  const { env, actorStore, kvStore } = makeFakes(["flag/dispatch_enabled"]);
  const cap = captureLog();
  try {
    const res = await handleSeed(seedRequest(makeBody(), TOKEN), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      actor_count: 2,
      kv_ok: 1,
      kv_failed: 1,
    });
    // The actor got everything; KV got only the customer entry.
    assert.equal(actorStore.size, 2);
    assert.equal(kvStore.size, 1);
    assert.equal(kvStore.get(`cust/${PHONE_DIGITS}`), JSON.stringify(RECORD));
    const done = parsed(cap.lines).find(
      (l) => typeof l.event === "string" && l.event.startsWith("seed_done"),
    );
    assert.match(String(done?.event), /kv_failed=1/);
    assert.equal(done?.outcome, "degraded");
  } finally {
    cap.restore();
  }
});

test("7. privacy: no token or phone digits in any log line", async () => {
  const { env } = makeFakes();
  const cap = captureLog();
  try {
    const res = await handleSeed(seedRequest(makeBody(), TOKEN), env);
    assert.equal(res.status, 200);
    await res.body?.cancel();
    // Plus a rejected call, so seed_fail is covered too.
    const forbidden = await handleSeed(
      seedRequest(makeBody(), "wrong-token-xyz"),
      env,
    );
    assert.equal(forbidden.status, 403);
    const joined = cap.lines.join("\n");
    assert.ok(!joined.includes(TOKEN), "no log line may contain the token");
    assert.ok(
      !joined.includes("wrong-token-xyz"),
      "no log line may contain the presented token",
    );
    assert.ok(
      !joined.includes(PHONE_DIGITS),
      "no log line may contain the phone digits",
    );
    assert.ok(
      !joined.includes("Ada Lovelace"),
      "no log line may contain record contents",
    );
  } finally {
    cap.restore();
  }
});
