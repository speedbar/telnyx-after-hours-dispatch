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
