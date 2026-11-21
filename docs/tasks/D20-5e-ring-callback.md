# D20-5e: ring start moves from the actor alarm to a function callback

Status: planned 21 Nov 2026. Branch: `d20-ring-live` (continue on it). Supersedes the "alarm runs startRing" part of D20-5b and spec section 1.2 option A (the alarm now only does the timing). AGENTS.md rules apply. Do this slice only. Do NOT change `src/lib/ring.ts`, `src/lib/ringrun.ts` or the reducer.

## Why
The first real call through the assistant did not ring. Evidence: `tech-01` and `tech-03` were stamped with `last_ring_at` and released about 0.4 s later; a real dial takes about 1 s. `/admin/ring-test` (runs in the function) rings fine. The ring start in `JobActor.alarm` runs inside the actor, and the actor appears NOT to see the function's secrets (`TELNYX_API_KEY`, `VOICE_CONNECTION_ID`, `DISPATCH_FROM_NUMBER`, `TECH_PHONES_JSON`), so the dial is silently skipped. This is an inference, not proven; the fix also makes the next failure visible because function logs are visible and actor logs are not (V-018).

## Design
The alarm keeps the timing (`RING_START_DELAY_MS`) and calls back into the FUNCTION, which has the secrets and runs the existing `startRing`. No shared secret is needed in the actor: a random single-use token is stored on the job at `create_job` time.

1. `create_job` (function side), on the fresh-success path where `setRingAt` is called today: generate a random token (16 bytes from `crypto.getRandomValues`, hex). Store on the job record `ring_token` and `ring_cb`, the absolute URL of this function's `POST /ring-start`, derived from the incoming request origin (pass the origin into the tool context if needed). If the origin cannot be obtained without inventing a new secret or config value, STOP and report. Never log the token or return it in any tool result. `create_job`'s result shape is unchanged.
2. `JobActor.consumeRingToken(token)`: atomic read-modify-write. Returns true only if the token equals the stored `ring_token` (constant-time compare) AND the ring status is idle or unset. On true it deletes the token (single use). Anything else returns false.
3. `JobActor.alarm`: when `ring_at` is due, consume `ring_at` first (order unchanged; a due retention still deletes first). Then POST `ring_cb` with JSON `{call_ref, token}` using `fetch` with a 3000 ms timeout, inside try/catch; the alarm never throws. Read the JSON `{ok, reason}`; persist `ring_alarm_ran_at` and `ring_start_reason` from the response. On fetch failure, timeout or non-200 use `callback_error`. Set `dispatch_state` to "unassigned" on any reason except `ok` and `mode_off`, exactly as in D20-5d. The alarm no longer calls `startRing`, `buildRingDeps` or reads secrets.
4. New route `POST /ring-start` (`src/routes/ringstart.ts`, registered in `src/index.ts` with the `{ ...env }` spread). Body `{call_ref, token}`, shape-checked. Resolve the JobActor stub by `call_ref`, call `consumeRingToken`. On false return the SAME 403 `{ok:false,error:"forbidden"}` for every failure (wrong token, replay, already ringing), with no detail. On true run `startRing(env, call_ref)` in the function and return 200 `{ok:true, reason}`. Never throws; 500 only on an unexpected exception. Log `ring_cb_fail` (reason code only) on rejection; never log the token.

## Tests
- Token generated and stored; never appears in the tool result or any log line.
- `consumeRingToken`: true once, then false (replay); false for a wrong token; false when the ring already started.
- `/ring-start`: 403 on wrong token and on replay with no `startRing` call; 200 and `startRing` called exactly once on a valid token.
- Alarm POSTs the stored `ring_cb` with the token and persists the reason; fetch failure or timeout gives `callback_error`, `dispatch_state` "unassigned", and the alarm does not throw; retention due still deletes first and makes no call.
- D20-5d tests updated for the new flow; `create_job` result shape unchanged.

## Docs (allowed in this slice)
- `docs/verify-log.md`: V-020, one line: ring start moved from the actor alarm to a function callback because the actor did not appear to have the function's secrets (inferred, not directly proven).
- `docs/decisions.md`: short D20 addendum with the same reason and the single-use-token design.

## Done when
`npx tsc --noEmit`, `npm test` and `npm run check:scrub` are green. Report, then stop. Do not commit or ship.

## Live check (Nabeel, after ship)
`ring_mode` is `live` and `RING_START_DELAY_MS` is 12000. Call the assistant from a SECOND phone (the technician phone must be free), describe a plumbing emergency, hang up when told the job is logged. About 12 s later `tech-01`'s phone rings; press 1. A `ring_cb_fail` or `ring_start` line now appears in `telnyx-edge logs dispatch`.
