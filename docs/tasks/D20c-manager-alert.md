# D20c: manager alert when nobody accepts

## Why
Live test sim-sms-1 passed (accept, dispatched, details SMS sent, sms_status sent). Known gap: when no technician accepts (all decline, no answer, or no technician can be rung) the job ends unassigned and nobody is told; it is only visible in /admin/job-state and logs. Add one SMS to a manager so a human can act.

## Behaviour
- New optional secret/config `MANAGER_PHONE` (digits or E.164, read with readConfig, normalised with toE164). If unset or empty: skip, log `sms_skipped` with error `no_manager`, never throw.
- Trigger, exactly once per job, on the two "nobody got it" outcomes: (1) the ring machine reaches its exhausted terminal state; (2) startRing ends with `no_candidates`. Find these in src/lib/ring.ts (exhausted path / `job_state` unassigned effect) and src/lib/ringstart.ts. Do NOT alert on `mode_off`, `capped`, or an accepted ring.
- Implement as ONE new effect `sms_manager` emitted by the reducer ONLY on exhaustion, executed by the runner outside the actor (same pattern as `sms_details`); for the `no_candidates` start path call the same sender function directly from ringstart. No other reducer behaviour changes.
- Reuse src/lib/sms.ts: same sender (`makeSmsSender`), same `sms_mode` flag (off | dry_run | live; missing or other = dry_run), same SMS_DAILY_CAP counter, same +61 allow-list and premium deny list (checkDialAllowed). Add a small exported `buildManagerSms(job)` (or a header option on buildAcceptSms) that produces, one item per line, max 320 chars, GSM-safe, Details is the only field cut:
  line 1 "{BUSINESS_NAME} - Job {job_id} UNASSIGNED"
  line 2 "Nobody accepted. {Urgency} {trade}" (stored values, first letter capitalised, no mapping)
  then "HAZARD: ..." (never truncated, omitted when empty or none), "Customer: ...", "Phone: ...", "Address: {address}, {suburb}" (suburb once), "Details: ..." , last line "Do not reply."
- Idempotent: before sending, read `manager_sms_status` on the job; if already set, do nothing (a duplicate webhook or a retry must not text twice). Stamp `manager_sms_status` (sent | dry_run | off | capped | failed | skipped) and `manager_sms_at` on the JobActor (same pattern as `smsDone`) and expose both in /admin/job-state.
- A failed or skipped manager text never changes dispatch_state, never throws, never blocks anything.
- Privacy: no phone number, name, address or body in any log line; dry run logs the length only; error logs carry a reason class only.

## Tests (new file tests/managersms.test.ts; never edit or overwrite another test file except where an existing assertion on the exhausted effect list must now include `sms_manager`: list each one)
- reducer: exhaustion emits `sms_manager` exactly once; accept, decline-with-a-next-candidate and no_input-with-a-next-candidate do not.
- runner: live sends once to MANAGER_PHONE with ref, UNASSIGNED, name, phone, address in the body; dry_run and off do not call the API; capped skips; API failure leaves state unchanged and stamps failed; no MANAGER_PHONE skips cleanly; non-+61 manager number is not texted; second invocation for the same job sends nothing.
- ringstart: `no_candidates` triggers one manager text; `mode_off` and `capped` do not.
- privacy: a scan of captured log lines contains none of the manager number, name or address.
- layout: hazards first and never cut, details cut at the cap, total at most 320.

## Token budget (strict)
Read only: src/lib/ring.ts (the exhaust path and the effect type union), src/lib/ringrun.ts, src/lib/sms.ts, src/lib/ringstart.ts, the JobActor `smsDone` method and the job-state route, and tests/acceptsms.test.ts for the fake pattern. No repo exploration. While iterating run only the new and changed test files; tsc once. Do NOT run the full suite (the owner runs it). Add `MANAGER_PHONE` (name only, optional) to .env.example and one line to docs/decisions.md (D20c). Do not commit. Report only: changed tests, new test count in the files you ran, new env names, `git status --short`, one line on anything unexpected.

## Live check (the owner)
Set the secret and ship. Run a job, press 2 when the technician phone rings: tech-01 declines, no other technician has a phone, the ring ends exhausted and the manager phone gets the text. job-state shows `manager_sms_status: sent` and dispatch_state unassigned.
