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
