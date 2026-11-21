# D20-5f: callback diagnostics, longer timeout, one retry

Status: planned 21 Nov 2026. Branch: `d20-ring-live`. Follows D20-5e. AGENTS.md rules apply (including the Tests rules: never overwrite an existing test file; new tests go in a new file). Do this slice only. Do NOT change `ring.ts`, `ringrun.ts`, the reducer or `startRing`.

## Why
Live run on sim-cb-1: the alarm fired (`ring_alarm_ran_at` set) but `ring_start_reason` was `callback_error` and the job ended `unassigned`. `callback_error` covers fetch throw, timeout, non-200 and bad body, so we cannot tell which. Possible causes: the origin stored in `ring_cb` is not reachable from the actor, the actor cannot reach that host, or the 3000 ms timeout is too short for a cold function start plus a dial.

## Changes
1. `JobActor.alarm`: when the callback fails, record on the job record: `ring_cb_error` (enum string: `timeout` | `network` | `http_<status>` | `bad_body` | `no_cb`), `ring_cb_host` (the hostname of `ring_cb` only, no path, no token, no query) and `ring_cb_ms` (elapsed milliseconds of the last attempt). On success record `ring_cb_ms` too. Never record the token or the full URL.
2. Timeout: raise the callback timeout from 3000 ms to 8000 ms (a constant in JobActor; the actor cannot be assumed to read config).
3. One retry: on `timeout` or `network` only (never on an HTTP status or bad body), retry the POST once with the same token after 500 ms. The token is single-use on the function side, so a duplicate cannot start two rings; if the first attempt had actually been processed, the retry gets 403 and the recorded reason stays the first response or `http_403`, never a second ring. Total worst case must stay within the actor method limits; if 2 x 8000 ms plus 500 ms is too long for an alarm, use 6000 ms per attempt and say so in the summary.
4. `/admin/job-state`: also return `ring_cb_error`, `ring_cb_host` and `ring_cb_ms` (enum strings, a hostname and a number only; still no PII, no token).

## Tests (new file `tests/ringcb.test.ts`; do not edit existing files except to adjust a test that the new behaviour forces, and list any such change)
- fetch throws -> `ring_cb_error` `network` after one retry; fetch aborts -> `timeout` after one retry.
- non-200 -> `http_<status>`, no retry; 200 with a body that is not `{ok, reason}` -> `bad_body`, no retry.
- success after one failed attempt: reason from the response, no error recorded.
- `ring_cb_host` is the hostname only; the token and the full URL appear in no record field and no log line.
- job-state returns the three new fields and still no PII or token.
- alarm still never throws; retention still deletes first; `dispatch_state` still "unassigned" on any reason except `ok` and `mode_off`.

## Docs
`docs/verify-log.md`: V-021 one line: what `ring_cb_error` / `ring_cb_host` showed on the first live run (leave "result: pending" until Nabeel reports it).

## Done when
`npx tsc --noEmit`, `npm test` and `npm run check:scrub` are green (run the tests with MCP_TOKEN, ADMIN_TOKEN and TELNYX_API_KEY unset). Report the test count against the last count (288). Stop. Do not commit or ship.
