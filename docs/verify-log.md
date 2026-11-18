# Verify log
One entry per Telnyx behaviour tested. Status: CONFIRMED (docs) | OBSERVED (we saw it) | FAILED | OPEN.

### V-001 Is Edge Compute enabled on this account? (T1)
Date: 17 Nov 2026. Test: shipped a hello-world TypeScript function. Result: live at https://hello-7213b47e-1.telnyxcompute.com, curl returned {"message":"Hello from Telnyx Edge Compute!"}. Status: OBSERVED.

### V-002 Are Stateful Actors enabled on this account? (T2)
Date: 17 Nov 2026. Test: scaffolded with `telnyx-edge new-func --actor --name=actortest`, shipped, repeated curl. Result: live at https://actortest-0d2fe03b-f.telnyxcompute.com; the counter returned 2, 3, 4, 5 on successive requests, so actor state persists. Status: OBSERVED.

### V-003 Can we create a KV namespace on this account? (T1)
Date: 17 Nov 2026, 12:28 UTC. Test: `telnyx-edge storage kv create --name dispatch-kv`. Result: the CLI printed "Request timeout: POST request to https://api.telnyx.com/v2/storage/kvs is taking too long", but `telnyx-edge storage kv list` then showed dispatch-kv (id ce309914-f9dc-49c6-9429-632418ecec27), status provision_ok. The server created it; only the client gave up. A direct curl to the same endpoint answered 401 immediately (API reachable), and status.telnyx.com showed no incident for API, Edge, Storage or KV. Lesson: after a create timeout, list before retrying. Status: OBSERVED.

### V-004 KV key format, first ship of `dispatch`, actor on the shipped function
Date: 17 Nov 2026, about 11:40 pm Sydney. Test: `telnyx-edge ship` of `dispatch` (commit 2382f1d), then curl. Result: shipped in 1m6s at https://dispatch-b823b5bf-9.telnyxcompute.com (scanner accepted the bundle, see BUG-001). GET /health returned {"ok":true}. POST /actor-test returned {"ok":true,"actor":"tech-01","pong":true,"count":1}. POST /kv-test failed: KV put("kvtest:ping") HTTP 400, code 10015, "Invalid key format. Allowed characters: a-z A-Z 0-9 - _ / = ." (see BUG-002). Status: OBSERVED. Open: re-test KV with a valid key (S0.3b).

### V-005 KV put/get with a valid key, TTL option accepted
Date: 17 Nov 2026, 11:52 pm Sydney. Test: `telnyx-edge ship` of `dispatch` after the S0.3b fix (56s), then `curl -X POST .../kv-test`. Result: {"ok":true,"key":"kvtest/ping","value":"2026-11-17T12:52:03.131Z","ttl_s":30}. Write and read-back work from the Edge function, and put with expirationTtl was accepted. Expiry itself (value gone after 30 s) is NOT yet observed. Status: OBSERVED (read/write); TTL expiry still to TEST with a read-only route.

### V-006 S0.1 evidence: OpenCode auth and Edge CLI surface (T/V17)
Date: 17 Nov 2026, 11:59 pm Sydney. Commands run on the Mac.
- `opencode auth list`: one credential, "telnyx api" (stored in OpenCode's own auth.json, not in the repo).
- `telnyx-edge --help` (v0.5.18) lists: actors, auth, bindings, config, delete-func, deployments (deploy history, including why deploys failed), dev, domains, help, inspect, list, log-export, logs, metrics, network, new-func, reset-func, revisions, rollback, secrets, ship, status, storage, tunnel, types, update. So logs, metrics, actors, storage are all present, and there are rollback, revisions, deployments and log-export commands we had not planned around.
- `telnyx-edge metrics --help`: `telnyx-edge metrics <function> [--errors] [--since 1h|24h|168h (max 168h, default 24h)] [--json]`. Summarises requests, HTTP error counts, latency, CPU, memory. `--errors` shows the HTTP 5xx count only; detailed exception classes and messages are not returned by this endpoint yet. `<function>` accepts a name or id.
Result: V17 `--errors` is CONFIRMED (it exists in v0.5.18). Status: OBSERVED.

### V-007 Do OpenCode inference tokens draw down the trial credit?
Date: 17 Nov 2026, 11:59 pm Sydney. Portal available balance: $4.89. Inference dashboard reported cost for the same period (52 requests, 1.13M tokens, all Kimi-K3 via OpenCode): $0.11. $5.00 minus $0.11 is $4.89. Result: the drop matches the reported inference cost to the cent, and nothing extra was taken for two Edge ships, KV and actor calls. Caveat: the starting balance of exactly $5.00 was not recorded before the first task, so this is an inference (strong). Status: OBSERVED, starting balance assumed. Implication: voice minutes (about $0.05/min plus LLM tokens) will use the rest, and a Paid top-up is needed for the two-phone transfer test anyway.

### V-008 Can this account create an assistant, and which types?
Date: 17 Nov 2026, 11:59 pm Sydney. Portal sidebar badge says "Trial". Create assistant opens "Choose an AI Assistant type" with two options: Single-prompt (Classic) and Conversation Workflow (Workflow). Result: assistant creation is available at Trial and the workflow type is offered (T3/S2.1 gate passed; per-node MCP tool scoping still untested). Status: OBSERVED.

### V-009 S1.2 live: signature verify, secrets and KV binding work in the umbrella runtime
Date: 18 Nov 2026, 12:55 am Sydney. After `secrets add TELNYX_PUBLIC_KEY` and `LOG_SALT` and a re-ship, `/health` showed both secrets present (booleans only), so process.env (or the helper's fallback) works in the umbrella runtime. A /dv call signed with a locally generated Ed25519 test key returned 200 with the customer variables, so Ed25519 verify via crypto.subtle and the `${timestamp}|${body}` format work at the edge for our own signer. Tampered body, 10-minute-old timestamp and missing headers each returned 403 with the logged reasons bad_signature, stale_timestamp and missing_headers. The `{ ...env }` spread kept the KV binding. Logs contained a 12-hex caller_hash and no phone digits. NOT yet verified: that Telnyx's own signature (real public key, real timestamp unit) passes. Status: OBSERVED.

### V-010 Latency of KV versus actor storage versus a plain route
Date: 18 Nov 2026, 1:01 am Sydney, from a Mac in Sydney to the edge URL, warm calls. /health 0.08 s; /actor-test (actor storage get + put) 0.09 to 0.10 s; /kv-test (KV put + get) 3.7 to 3.9 s; /dv (2 KV gets) about 3.0 to 3.3 s server-side. So one KV operation is about 1.5 to 1.9 s and one actor storage operation is well under 0.1 s. Cause of the KV cost unknown (VERIFY: tier, region, or KV consistency settings). Implication: no KV access on a voice turn or inside the 1.5 s dynamic-variables webhook (see BUG-003, D13). Status: OBSERVED.

### V-011 S1.2b live: DirectoryActor hot path, guarded seed route
Date: 18 Nov 2026, 1:58 am Sydney. After shipping S1.2b (first ship failed once with an HTTP/2 PROTOCOL_ERROR and succeeded on retry, 1m16s): POST /admin/seed with the token returned ok, actor_count 2, kv_ok 2, kv_failed 0 in 6.6 s (the two KV puts dominate); without the token it returned 403. Three signed /dv calls returned the known-caller variables with no dv_degraded: dv_lookup (actor) 12 to 24 ms, dv_out 14 to 31 ms server-side, curl time_total 0.22 to 0.35 s from Sydney (each curl opens a new TLS connection). The DIRECTORY actor binding survives the `{ ...env }` spread. Logs show no phone digits. The seed_done log line carries its counts inside the event string (known wart, log.ts has no count fields). Status: OBSERVED. Cost of the S1.2b OpenCode run: about $0.84 (balance $4.43 to $3.59).

### V-012 Actor alarm API and concurrency guarantee, from the installed @telnyx/edge-runtime types
Date: 18 Nov 2026, 3:30 am Sydney. Read from node_modules type declarations, not yet observed live. Alarm API: ctx.storage.setAlarm(whenMs), getAlarm(), deleteAlarm() (ctx.setAlarm is an alias); the base class has alarm(alarmInfo) with retryCount and isRetry; delivery is at least once, so the handler must be idempotent. AlarmInfo is exported from the package root (tsc accepted `import type { AlarmInfo }`). The storage docs say per-actor method serialization gives effective ACID at the actor level, which is the basis for the "two callers never get the same technician" claim. Storage also offers transaction, transactionSync and a SQL interface (not used). Status: READ FROM TYPES. To observe live in the S1.3b check: concurrency script (expect ok=1 busy=5) and a reserve with ttl_s 5 followed by a status call after 6 s (expect available).

### V-013 S1.3a offline checks (TechnicianActor), Kimi-K3 run
Date: 18 Nov 2026, 3:30 am Sydney. `tsc --noEmit` exit 0; scrub clean; no console.log outside src/lib/log.ts; 56 of 56 tests pass (50 existing plus 6 new, including a real 1.1 s hold expiry). Not yet live: needs S1.3b's route and a ship. Known weaknesses recorded: the shared lazy-expiry helper logs hold_expired on every read of an expired hold until a write clears it (duplicate log lines possible, also in release and setShift); the Map-backed fake returns the stored object by reference so the helper's in-place edit can hide a missing write in unit tests (the live check covers it); reserve() does not cap the length of call_ref or job_id (the S1.4 tool boundary must). Status: OBSERVED offline.
