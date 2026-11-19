# Test matrix

Only what was actually run is marked PASS or FAIL. Everything else is NOT RUN.

## Automated (npm test)

| Area | Result | Evidence |
|---|---|---|
| Unit tests through S1.3a (56 tests, including a real 1.1 s hold expiry) | PASS at that time | V-013 |
| S1.5 tests (call identity, fail-closed, required fields) | NOT RUN by me; written by OpenCode, unreviewed | S1.5 working tree |
| `tsc --noEmit`, SDK-example scrub check | PASS at S1.3a | V-013 |

## Live checks

| ID | Check | Result |
|---|---|---|
| V-009 | /dv signature verify, secrets present, KV binding | PASS |
| V-010 | Latency: KV 1.5 to 1.9 s per op, actor under 0.1 s | Recorded (drove D13) |
| V-011 | DirectoryActor hot path, seed route guarded (403 without token) | PASS |
| V-014 | TechnicianActor: 6 parallel reserves gave ok=1 busy=5; release; hold expiry | PASS |
| V-015 | /mcp tools/list returns 4 tools; reserve and release work | PASS |
| V-016 | Which `_meta` keys Telnyx sends | OPEN |

## Conversation tests (Portal Test assistant)

| Test | Result |
|---|---|
| 1 to 3 (emergency, details, reserve) | Run; test 3 found BUG-006 to BUG-011 (see bug journal) |
| Re-test after S1.5 | NOT RUN (S1.5 not shipped) |
| Test 4 (clean run end to end) | NOT RUN |
| Forced fallback (no technician free) | NOT RUN |
| Failure drill (wrong token, expect auth failure) | NOT RUN |
| Gas and water safety wording | NOT RUN live |
| Real phone call | NOT RUN (no number) |
