# D20-5g: start the ring inline from create_job (skip the actor callback)

## Why
Live test sim-cb-2 (D20-5f deployed): the alarm in JobActor POSTs to `/ring-start` on our own public host and times out twice (`ring_cb_error: timeout`, `ring_cb_host` correct, `ring_cb_ms: 8001`, ring_alarm_ran_at about 16 s after the alarm). No `/ring-start` log line showed up in `telnyx-edge logs dispatch` within 2 minutes. Cause is NOT proven. Two hypotheses:
1. Re-entrancy: the alarm holds JobActor while it waits for `/ring-start`, and `/ring-start` calls the same JobActor (consumeRingToken), so both wait.
2. The actor cannot make outbound calls to its own public URL.

We do not need to settle it before the deadline. The function itself is proven to work: `/admin/ring-test` runs startRing -> runRing -> dial -> webhook -> accept -> dispatched end to end. So start the ring from the function, inside create_job.

## Change
In `create_job` (runs in the function, has env and secrets), after the job is written and the technician is marked booked:
- Call `startRing(env, callActor)` inline, wrapped in a hard 3 s overall timeout (Promise.race with a timer). Never throw. Never let it fail create_job: the tool result to the assistant must stay `ok: true` with the spoken reference.
- If it returns `started: true`: cancel the pending alarm ring (setRingAt(null) or equivalent) so a later alarm cannot start a second ring. If the existing design already makes startRing idempotent for the same job, keep that guarantee and add a test for it.
- If it returns not started, or times out, or errors: record `ring_start_reason` (use existing values: mode_off, capped, no_job, no_candidates, deps_error, run_error) and set `dispatch_state` to `unassigned` (the existing D20-5d safety net). Leave the existing alarm + callback path in place as a fallback only when the reason is `deps_error` or `run_error`/timeout.
- Env flag `RING_INLINE`: unset or "1" = inline (new default). "0" = old alarm path only. Document it in the README env table.
- `RING_START_DELAY_MS` is ignored in inline mode (no delay). Keep it for the "0" path.
- ToolCtx needs `env` (and whatever startRing needs). Pass it from `src/routes/mcp.ts` the same way `origin` is passed.
- Latency: create_job currently takes ~90 ms. The dial adds one Telnyx API call (a few hundred ms). Log `hop_ring_ms` with the real inline duration. Keep the 3 s cap.

## Tests (new file `tests/ringinline.test.ts`, do not edit or overwrite any existing test file)
- inline start succeeds: create_job returns ok, ring status set, alarm ring cancelled.
- startRing returns not started (mode_off, capped): create_job still ok, ring_start_reason recorded, correct dispatch_state.
- startRing throws: create_job still ok, `unassigned`.
- startRing hangs: create_job returns within about 3 s (fake timers or an injectable timeout) and still ok.
- `RING_INLINE=0`: old behaviour (ring_at set, no inline call).
- double start: inline start then the alarm path for the same job does not dial twice.
Use the existing Map-backed fakes. Report the new total; it must be at least 296 plus the new tests. List any test you change (there should be none, except where create_job tests must now supply `env`; list those explicitly).

## Docs
Not part of this slice. Do not touch docs/verify-log.md or docs/decisions.md; they are written separately.

## Token budget (strict, balance is low)
- Read only: src/tools/create_job.ts, src/routes/mcp.ts, src/tools/index.ts, src/lib/ringstart.ts, src/actors/JobActor.ts (only the ring_at / setRingAt parts), and one existing test file for the fake pattern (tests/ringroute.test.ts). Do not read other files and do not explore the repo.
- While iterating run only `tests/ringinline.test.ts` and `tests/tools.test.ts`. Run tsc once and the full suite once at the end.
- Do not print file contents or test output back in your report. Report only: new test total, list of changed tests, `git status --short`, and one line on anything unexpected.

## Live check (the user runs this, not you)
Deploy, then `sim-cb-3`: reserve_technician + create_job, then job-state. Expect `ring_start_reason: ok`, the phone rings immediately, press 1, `dispatch_state: dispatched`.

## Rules
Standing rules in AGENTS.md apply (tests, no secrets, scrub, commit trailer). Run `npx tsc --noEmit`, the tests with `env -u MCP_TOKEN -u ADMIN_TOKEN -u TELNYX_API_KEY`, and the scrub. Do not commit; the user does git.
