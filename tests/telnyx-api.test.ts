// tests/telnyx-api.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeTelnyxClient,
  makeDialer,
  encodeClientState,
  decodeClientState,
} from "../src/lib/telnyx-api.js";

const ENV = { TELNYX_API_KEY: "fake-test-key" };

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, captured: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const bodyOf = (c: Captured) => JSON.parse(c.init.body as string) as Record<string, unknown>;
const authHeader = (c: Captured) => (c.init.headers as Record<string, string>).Authorization;

test("dial: POST /v2/calls with exactly the spec fields, Bearer header, command_id through", async () => {
  const cap: Captured[] = [];
  const client = makeTelnyxClient(ENV, fakeFetch(200, { data: { call_control_id: "ccid_1" } }, cap));
  const r = await client.dial({
    connection_id: "conn-1",
    to: "+61400000000",
    from: "+12125550000",
    client_state: "QUJD",
    timeout_secs: 25,
    time_limit_secs: 120,
    command_id: "cmd-1",
  });
  assert.deepEqual(r, { ok: true, call_control_id: "ccid_1" });
  assert.equal(cap.length, 1);
  assert.equal(cap[0].url, "https://api.telnyx.com/v2/calls");
  assert.equal(cap[0].init.method, "POST");
  assert.equal(authHeader(cap[0]), "Bearer fake-test-key");
  assert.deepEqual(bodyOf(cap[0]), {
    connection_id: "conn-1",
    to: "+61400000000",
    from: "+12125550000",
    client_state: "QUJD",
    timeout_secs: 25,
    time_limit_secs: 120,
    command_id: "cmd-1",
  });
});

test("gatherUsingSpeak: action URL, exact body with defaults (timeout_millis 8000)", async () => {
  const cap: Captured[] = [];
  const client = makeTelnyxClient(ENV, fakeFetch(200, {}, cap));
  const r = await client.gatherUsingSpeak("ccid_1", {
    payload: "brief text",
    voice: "Telnyx.KokoroTTS.af",
    language: "en-AU",
    client_state: "QUJD",
    command_id: "cmd-2",
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(cap[0].url, "https://api.telnyx.com/v2/calls/ccid_1/actions/gather_using_speak");
  assert.equal(cap[0].init.method, "POST");
  assert.deepEqual(bodyOf(cap[0]), {
    payload: "brief text",
    voice: "Telnyx.KokoroTTS.af",
    language: "en-AU",
    minimum_digits: 1,
    maximum_digits: 1,
    valid_digits: "12",
    timeout_millis: 8000,
    maximum_tries: 1,
    client_state: "QUJD",
    command_id: "cmd-2",
  });
});

test("speak and hangup: URLs, speak body, hangup sends no body", async () => {
  const cap: Captured[] = [];
  const client = makeTelnyxClient(ENV, fakeFetch(200, {}, cap));
  const s = await client.speak("ccid_1", { payload: "thanks", voice: "v", language: "en-AU", command_id: "cmd-3" });
  const h = await client.hangup("ccid_1");
  assert.deepEqual(s, { ok: true });
  assert.deepEqual(h, { ok: true });
  assert.equal(cap[0].url, "https://api.telnyx.com/v2/calls/ccid_1/actions/speak");
  assert.deepEqual(bodyOf(cap[0]), { payload: "thanks", voice: "v", language: "en-AU", command_id: "cmd-3" });
  assert.equal(cap[1].url, "https://api.telnyx.com/v2/calls/ccid_1/actions/hangup");
  assert.equal(cap[1].init.body, undefined);
});

test("error mapping: 401 -> http_4xx, 500 -> http_5xx, abort -> timeout, throw -> network", async () => {
  const cap: Captured[] = [];
  const c401 = makeTelnyxClient(ENV, fakeFetch(401, { errors: [{ code: "10014" }] }, cap));
  assert.deepEqual(await c401.hangup("x"), { ok: false, reason: "http_4xx" });
  const c500 = makeTelnyxClient(ENV, fakeFetch(500, { errors: [{ code: "90001" }] }, cap));
  assert.deepEqual(await c500.hangup("x"), { ok: false, reason: "http_5xx" });
  const aborting = (async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }) as typeof fetch;
  assert.deepEqual(await makeTelnyxClient(ENV, aborting).hangup("x"), { ok: false, reason: "timeout" });
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await makeTelnyxClient(ENV, failing).hangup("x"), { ok: false, reason: "network" });
});

test("no_key: missing TELNYX_API_KEY never calls fetch; failure logs carry no key, number or brief", async () => {
  const cap: Captured[] = [];
  const client = makeTelnyxClient({}, fakeFetch(200, {}, cap));
  assert.deepEqual(await client.hangup("x"), { ok: false, reason: "no_key" });
  assert.equal(cap.length, 0);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const c = makeTelnyxClient(ENV, fakeFetch(401, { errors: [{ code: "10014", detail: "secret detail" }] }, []));
    await c.gatherUsingSpeak("ccid_1", { payload: "call 61400000000 now", voice: "v", language: "en-AU" });
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  assert.ok(out.includes("http_4xx"));
  assert.ok(out.includes("10014"));
  assert.ok(!out.includes("fake-test-key"));
  assert.ok(!out.includes("61400000000"));
  assert.ok(!out.includes("secret detail"));
});

test("makeDialer: config to dial body (E.164, 25/120 s), not gated here", async () => {
  const cap: Captured[] = [];
  const env = { ...ENV, VOICE_CONNECTION_ID: "conn-9", DISPATCH_FROM_NUMBER: "12125550000" };
  const dial = makeDialer(env, fakeFetch(200, { data: { call_control_id: "ccid_9" } }, cap));
  const r = await dial("61400000000");
  assert.deepEqual(r, { ok: true, call_control_id: "ccid_9" });
  assert.deepEqual(bodyOf(cap[0]), {
    connection_id: "conn-9",
    to: "+61400000000",
    from: "+12125550000",
    timeout_secs: 25,
    time_limit_secs: 120,
  });
});

test("makeDialer: missing VOICE_CONNECTION_ID -> no_config, fetch untouched", async () => {
  const cap: Captured[] = [];
  const dial = makeDialer(ENV, fakeFetch(200, {}, cap));
  assert.deepEqual(await dial("61400000000"), { ok: false, reason: "no_config" });
  assert.equal(cap.length, 0);
});

test("client_state codec: round-trip survives, bad input is null", () => {
  const s = { c: "c:abc123", j: "JA4F7C", t: "tech-01", a: 2 };
  assert.deepEqual(decodeClientState(encodeClientState(s)), s);
  assert.equal(decodeClientState(""), null);
  assert.equal(decodeClientState(undefined), null);
  assert.equal(decodeClientState(42), null);
  assert.equal(decodeClientState("!!!not-base64"), null);
  assert.equal(decodeClientState(btoa("[]")), null);
  assert.equal(decodeClientState(btoa("{}")), null);
  assert.equal(decodeClientState(btoa(JSON.stringify({ c: "x", j: "y", t: "z", a: "1" }))), null);
  assert.equal(decodeClientState(btoa(JSON.stringify({ c: "x", j: "y", t: "z", a: 1.5 }))), null);
});
