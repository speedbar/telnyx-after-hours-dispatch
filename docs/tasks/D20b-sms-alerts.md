# D20b — SMS messages and decline tracking: task spec for OpenCode

Written Sat 21 Nov 2026. Depends on D20 (`docs/tasks/D20-technician-ring.md`): do not start until D20 Branch B is merged and shipped, because this extends the ring reducer, `/voice-events`, the dialer and the modes. Branch: `d20b-sms-alerts`. Numbering: D20b only; do not reuse D20 or D21.

## 0. Goal and non-goals
Goal: (1) text the accepting technician the full job details; (2) tell the manager by text when an emergency job is declined, and when nobody accepts; (3) keep a small record of declines per technician; (4) ask a declining technician for a one-digit reason.
Non-goals: any UI or dashboard (the record is logs plus actor state); two-way SMS or replies; texts to the caller; HR-style judgement (the manager text is neutral facts only); bridging the caller (D21); changing the Portal.
Rule: SMS never decides dispatch state. A job is `dispatched` only after a technician pressed 1 on the ring. A failed or skipped SMS never undoes or blocks a dispatch, escalation or release.

## 1. Messages (templates are pure functions, no LLM)
Characters: plain GSM-7 only (strip emoji and non-GSM characters), no URLs, hard cap 320 characters (two segments), end with "Do not reply." Free-text fields (summary, hazards, address) are length-capped, control characters stripped, and treated as data.
- M1 `accept_details` -> the technician who pressed 1: job reference, urgency, trade, address and suburb, customer name if known, callback number (digits), hazards, summary. Sent after the accept is recorded.
- M2 `decline_alert` -> manager, only when urgency is `emergency`: "Emergency job <ref> (<trade>, <suburb>): <tech id> declined, reason: <on_job|unavailable|other|none>. Ringing next technician." Facts only. Configurable minimum urgency `DECLINE_ALERT_MIN_URGENCY` (default `emergency`; `urgent` also accepted).
- M3 `next_accepted` -> manager: "<ref>: <tech id> accepted." Send only if M2 was sent for that job. FIRST ON THE CUT LIST.
- M4 `exhausted_alert` -> manager, always when the ring ends `exhausted` (any urgency): "No technician accepted job <ref> (<urgency>, <trade>, <suburb>). Please take over. Callback <digits>." Job `dispatch_state` becomes `owner_alerted_unconfirmed`, never `dispatched`.
Not built: a "you missed a call" text to the technician who did not answer.

## 2. Decline reason menu (extends the D20 reducer)
After a technician presses 2, the ring speaks a second prompt via `gather_using_speak`: "Press 1 if you are on another job, 2 if you are unavailable, 3 for another reason." (`minimum_digits` 1, `maximum_digits` 1, `valid_digits` "123", about 6 s timeout). Reason values: `on_job`, `unavailable`, `other`, `none` (timeout or hung up). The decline is finalised and the next technician is rung after the reason gather ends or times out; never wait longer than the timeout. Reducer: new state `awaiting_reason`; table-driven tests for each digit, timeout, hang-up during the menu, duplicate and stale events (reuse the D20 dedupe).

## 3. Decline tracking (actor state, no UI)
- `TechnicianActor.recordDecline({job_id, urgency, reason, at})`: keeps the last 20 as `declines`, plus the day's count; exposed through `status()` and therefore through `/admin/tech` `status`. Job reference only, never names, addresses or phone numbers. Expiry: entries older than 7 days dropped lazily (match `JOB_RETENTION_DAYS` spirit).
- The job's `ring.outcome_log` already holds who was rung and what they answered (D20); add `reason` to the decline entries.
- Optional, CUT-SECOND: `GET /admin/report` (`ADMIN_TOKEN`, `tokenEqual`) returning a JSON summary of the three technicians' recent declines. Read-only, no personal data.

## 4. Sending
- `src/lib/sms.ts`: `sendSms({to, text})` over the Telnyx Messages API (`POST https://api.telnyx.com/v2/messages` with the messaging profile and sender). Exact request fields, and how the Alpha sender on profile `dispatch-sms` is supplied as `from`, are VERIFY against the Telnyx docs; check them, do not guess, and record the result in `docs/verify-log.md`. Reuse the D20 API client (timeouts, errors as data, key never logged).
- Config: secrets `MESSAGING_PROFILE_ID`, `MANAGER_PHONE` (falls back to `FALLBACK_NUMBER` if absent), `TELNYX_API_KEY` (already added in D20). Non-secret: `SMS_FROM` (the Alpha sender text), `SMS_DAILY_CAP` (default 20), `DECLINE_ALERT_MIN_URGENCY`. Add names only to `.env.example`; extend `/health` with presence booleans; never log values.
- Mode flag `sms_mode` (`flag/sms_mode` in the DirectoryActor): `off` | `dry_run` | `live`; MISSING or any other value = `dry_run`. Dry run logs `sms_dry_run` with message type, recipient role (technician or manager), body length and a body hash; never the body, never a number.
- Recipients are normalised with the D20 helpers and checked against `ALLOWED_DIAL_PREFIXES` (default `+61`) before sending; a technician or manager number that fails is skipped with `sms_skipped` (reason code only).
- Idempotency: the JobActor keeps `sms_sent` (set of `<type>:<recipient role>`); a repeat call (webhook retry, re-entered state) logs `sms_dup` and sends nothing. Daily SMS cap counted in the DirectoryActor like the ring cap; cap hit logs `sms_capped`.
- Failure: one attempt, no retry loop. `sms_fail` logs the HTTP status class and Telnyx error code only. The ring carries on.

## 5. Logs (no PII; job ref, technician id, `conv_hash`)
`sms_dry_run`, `sms_sent` (with Telnyx message id), `sms_fail`, `sms_skipped`, `sms_dup`, `sms_capped`, `decline_recorded` (technician_id, job_id, urgency, reason), `decline_alert_sent`. If a new `LogFields` key is needed, update the log key-list test and state the new count. Second signal: time from `ring_outcome` (decline) to `sms_sent` for M2.

## 6. Slices (one OpenCode task each; branch `d20b-sms-alerts`)
- D20b-1 Pure logic: message templates M1 to M4 with sanitising and the 320-character cap, alert policy function `(job, outcome, reason, config) -> messages[]`, reason parsing, reducer extension with `awaiting_reason`. Tests: injection-style summary stays capped and plain; emergency vs urgent policy; M3 only after M2; exhausted always alerts; no template contains a number it was not given.
- D20b-2 Actors: `TechnicianActor.recordDecline` and `declines` in `status()`, `JobActor` `sms_sent` and `dispatch_state` `owner_alerted_unconfirmed`, DirectoryActor SMS counter, `sms_mode` flag read. Tests with the fake-storage pattern in `tests/technician.test.ts`; `scripts/concurrency.ts` still passes.
- D20b-3 Wire-up: `sms.ts` client, sends from the `/voice-events` handler effects, reason gather prompt, modes, caps, `/health` booleans, `docs/decisions.md` D20b entry, `docs/verify-log.md` lines.
Each slice: `npx tsc --noEmit`, `npm test`, `npm run check:scrub`, show results, stop. Never commit, ship, add secrets or touch `.opencode/`. Commit trailer on every OpenCode commit: `Built with OpenCode (@telnyx/opencode); model: Kimi-K3`.

## 7. Live verification (Nabeel)
1. `sms_mode` unset: ring and decline; confirm only `sms_dry_run` lines, no text arrives.
2. Set `live`, manager number = your own mobile: press 1 on a ring -> M1 arrives with the right details. Press 2 then a reason on an emergency job -> M2 arrives and the next technician is rung. Let a ring time out with no answer on every technician -> M4 arrives.
3. Press 2 on an `urgent` (non-emergency) job -> no M2, a `decline_recorded` log line.
4. Repeat the same `/voice-events` request (replay) -> `sms_dup`, no second text.
5. `sms_mode=off` -> nothing sent; ring and dispatch unaffected.
Trial/Paid limits still apply (VERIFY): messages may carry the "Unverified" Alpha sender label; profile spend cap is $2 a day; $0.04 per message, so a full test run costs cents.

## 8. Risks
- R1 SMS to a technician or manager is the first place caller details leave the system in text form: only the technician who accepted gets M1, only the manager gets M2/M3/M4, never logged, and the recipients are our own people. State this in `docs/` security notes.
- R2 SMS is one-way and unconfirmed: the manager may not read it. It is a notification, not an acknowledgement; the talking point is that the job state says `owner_alerted_unconfirmed`.
- R3 A decline alert can look like blame: neutral wording only; a legitimate decline (unsafe, ill, already working) is why the reason menu exists. Real use needs a policy; say so.
- R4 "On a job" is a timer today (`DISPATCH_BUSY_S`), not a real signal; the demo clears it by hand.
- R5 Alpha sender and international delivery behaviour (error 40306 seen earlier) may differ by destination; verify with the real manager number.

## 9. Cut list (in this order)
1. M3. 2. `/admin/report`. 3. The reason menu (record `none` always). 4. M1. Never cut: `sms_mode` dry run, idempotency, M4, the rule that SMS never decides dispatch state.
