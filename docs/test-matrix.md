# Test matrix

Only what was actually run is marked PASS or FAIL. Everything else is NOT RUN. Last updated 22 Nov 2026.

## Automated

| Area | Result | Evidence |
|---|---|---|
| `npm test`: 340 tests across the actors, tools, ring reducer, SMS, manager alert, signature and validation | PASS (fresh export of main, `npm ci`, Node 22) | `env -u MCP_TOKEN -u TELNYX_API_KEY -u ADMIN_TOKEN npm test` |
| `tsc --noEmit` | PASS | `npm run typecheck` |
| SDK-example scrub check | PASS | `npm run check:scrub` (runs on install) |
| Conversation golden set (chat-test harness) | Exists, NOT in CI, not run for the final build | `scripts/chat-test.ts` |

## Live checks

| ID | Check | Result |
|---|---|---|
| V-009 | /dv signature verify, secrets present, KV binding | PASS |
| V-010 | Latency: KV 1.5 to 1.9 s per op, actor under 0.1 s | Recorded (drove D13) |
| V-011 | DirectoryActor hot path, seed route guarded (403 without token) | PASS |
| V-014 | TechnicianActor: 6 parallel reserves gave ok=1 busy=5; release; hold expiry | PASS |
| V-015 | /mcp tools/list; reserve and release work (4 registered, 3 used by the workflow) | PASS |
| V-016 | Which `_meta` keys Telnyx sends | OPEN |
| V-022 | Alarm callback to /ring-start times out | FAIL, worked around (BUG-025) |
| V-023 | Accept SMS and manager SMS delivered | PASS |
| V-024 | Warm transfer to a human: accept, no, no answer | PASS |

## Conversation and phone tests

| Test | Result |
|---|---|
| Real phone call end to end (triage, details, reserve, job, reference, hangup) | PASS (several calls, 20 and 21 Nov) |
| Technician ring: press 1 accept, then details SMS | PASS |
| Technician ring: press 2 decline, thank-you, hangup | PASS |
| Ring exhausted, one manager SMS | PASS (jobs JAGDYE, JA7TK7 chain) |
| Human transfer: accept, no, no answer | PASS |
| Filler line heard once after the 3500 ms delay (BUG-026) | NOT CONFIRMED |
| Emergency-services line and name read-back (cfg-8) | NOT REPORTED |
| One normal regression call after the last changes | NOT RUN |
| Fallback spoken by voice (forced failure) | NOT RUN |
| Failure drills: flags off, wrong token, wrong VOICE_CONNECTION_ID | NOT RUN |
| Inbound call concurrency | NOT RUN (no published limit found) |
