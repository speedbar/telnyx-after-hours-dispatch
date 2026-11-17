# Bug journal
Each entry: When / where, Symptom, Evidence, Hypotheses ruled out, Root cause, Fix, Signal that found it, What we would add to catch it faster.

### BUG-001 Server-side secret scanner rejects `telnyx-edge ship` (false positive in SDK example values)
When / where: 17 Nov 2026, `telnyx-edge ship` (CLI v0.5.18) of the Stateful Actor scaffold "actortest".
Symptom: HTTP 422 "upload contains what looks like a secret ... index.ts:55609 (generic-api-key)".
Evidence: CLI error with the bundle line number. Rebuilt the bundle locally with esbuild (--platform=node) and read the lines around 55609: an example `token_group_id: '182bd5e5-...'` UUID in the bundled `telnyx` SDK (node_modules/telnyx).
Hypotheses ruled out: a Tailscale `tskey-auth-...` example in the same SDK was also edited, but it was not the trigger.
Root cause: false positive of the server-side secret scanner on doc-comment example values in the `telnyx` SDK, which @telnyx/edge-runtime pulls into the bundle (about 2.6 MB; it also bundles @aws-sdk/client-s3).
Fix: replaced the example UUID with EXAMPLE across node_modules/telnyx, after which `ship` succeeded. `npm install` undoes the edit, so scripts/scrub-sdk-examples.mjs runs as a postinstall hook (`npm run check:scrub` verifies).
Signal that found it: the CLI error with a line number, plus a local reproduction of the bundle.
What we would add: run `npm run check:scrub` before every ship. Open: check whether this is fixed upstream.
Status: PROVEN 17 Nov 2026, 11:40 pm Sydney. A real `telnyx-edge ship` of `dispatch` (built from the committed repo, postinstall scrub in place) was accepted by the scanner (shipped in 1m6s, no 422).

### BUG-002 KV rejects keys containing a colon (and the design used colon keys)
When / where: 17 Nov 2026, live `dispatch` function, `POST /kv-test`, which wrote the key "kvtest:ping".
Symptom: HTTP 500 from our route with `kv_error`; detail: env KV put("kvtest:ping") failed: HTTP 400, code 10015, "Invalid key format. Allowed characters: a-z A-Z 0-9 - _ / = .".
Evidence: curl output from the deployed function. The error comes from the KV service, not our code, and the same call path works for the actor (/actor-test returned ok).
Hypotheses ruled out: namespace or binding problem (the 400 names the key, and the binding resolved); expirationTtl option (the message is about the key).
Root cause: the KV service allows only a-z A-Z 0-9 - _ / = . in keys. Our design (doc 09 section 5.4) used ":" separators (flag:, cust:, job:, job-by-call:) and "+" in E.164 phone numbers, and call ids from Telnyx contain ":" ("v3:..."). The facts table (V23) did not list a key character rule, so nothing flagged it. Actor names do allow ":" (V24); only KV is strict.
Fix: use "/" as the separator in every KV key (flag/dispatch_enabled, cust/<e164 without +>, job/<job_id>, job-by-call/<call_ref sanitised>), and build all keys through one helper that validates them. Test route key becomes "kvtest/ping" (task S0.3b).
Status: FIXED and verified 17 Nov 2026, 11:52 pm Sydney (V-005): /kv-test with key "kvtest/ping" returned ok:true.
Signal that found it: a deployed test route that does a real write and read-back (a local type check cannot catch this, and `telnyx-edge dev` might not enforce it).
What we would add to catch it faster: a key-format row in the verified-facts table; a unit test that every key builder output matches /^[A-Za-z0-9\-_\/=.]+$/.

### BUG-003 KV operations take about 1.5 to 1.9 s each, and some fail intermittently, so /dv blows the dynamic-variables timeout
When / where: 18 Nov 2026, about 12:55 to 1:01 am Sydney, live `dispatch` function, `POST /dv` (S1.2) and `POST /kv-test`.
Symptom: a correctly signed /dv call returned the right variables but took 3.0 to 3.6 s (Telnyx's default webhook timeout is 1.5 s). Separately, three calls in a row for the seeded number returned `caller_known:"false"` with 200.
Evidence: dv_out latency_ms 3320 and 3022 on healthy calls; curl time_total 3.1 to 3.6 s. Three calls logged `dv_degraded` with error `lookup_failed:Error` (dv_out latency 1783, 296 and 1875 ms). GET /health took 0.08 s warm; POST /actor-test (storage get + put inside the actor) took 0.09 to 0.10 s; POST /kv-test (one KV put + one KV get) took 3.7 to 3.9 s. /dv does two sequential KV gets.
Hypotheses ruled out: network or function slowness (/health is 80 ms); Ed25519 verify or hashing (the actor route and /health are fast, the KV route is slow and /dv matches 2 x KV get); the `{ ...env }` spread losing the KV binding (the same code returned the customer on other calls, so the binding resolves).
Root cause: KV operations from the edge function cost about 1.5 to 1.9 s each. Why is unknown (trial tier, distant KV backend, or a per-request cost); VERIFY. The intermittent `Error` is a KV get throwing; its message is not yet logged (the dv log keeps the error name only, because KV errors can contain the key and the key contains the phone number).
Fix: planned in task S1.2b. Keep KV off the voice hot path. Hot state (customer lookup, flags, later reservations) lives in Stateful Actor storage, which is about 15 times faster. KV stays the system of record, written off the hot path.
Signal that found it: the dv_out latency_ms field, a curl time_total comparison across /health, /actor-test and /kv-test, and the dv_degraded log line.
What we would add to catch it faster: a latency budget per route in the spec, and a timed live call on every task that touches storage.
Status: FIXED (by avoiding KV on the hot path) and verified live 18 Nov 2026, 1:58 am Sydney (V-011): /dv now takes 14 to 31 ms server-side (curl 0.22 to 0.35 s from Sydney including TLS), down from about 3.0 to 3.6 s. The slowness of KV itself is NOT fixed and its cause is still unknown.
