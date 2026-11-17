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

Pending S0.1 evidence: output of `opencode auth list`, `telnyx-edge --help`, `telnyx-edge metrics --help`.
