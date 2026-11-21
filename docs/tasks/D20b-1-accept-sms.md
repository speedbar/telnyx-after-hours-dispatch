# D20b-1: shorter spoken brief + details by SMS after accept

## Why
Live test sim-cb-3 works (ring starts inline). Product decision from the owner: the spoken brief must NOT read the customer's phone number or name. It gives job type, urgency, address and the reference, then says details will be texted after the technician accepts (press 1). After accept, one SMS carries the full details.
This is a SUBSET of docs/tasks/D20b-sms-alerts.md. Read that file for naming, env, flag and sender conventions. Implement only what is below. Do NOT build: manager text, next-accept text, decline-reason menu.

## Change 1: spoken brief (templated, no LLM)
Content, in this order: urgency and trade, suburb and street address (spoken digits for the house number as today), reference spaced letter by letter, then "Press 1 to accept, 2 to decline. The customer details will be texted to you after you accept." No customer name. No phone number. Keep the existing wording style and length limits of the current brief builder. Update its tests (list each changed test).

## Change 2: SMS on accept
- New effect `sms_details`, produced by the pure reducer only on the transition to accepted (next to the existing dispatched marking and confirmation speech). Executed by the effect runner outside the actor, at most once per ring attempt, with a per-effect log line.
- Message text (plain, under 320 characters, no emoji): reference, trade and urgency, customer name, callback number, address, details/hazards (truncate details to fit). The data comes from the JobActor briefing (customer_name, address, callback, details).
- Sender and API: follow D20b-sms-alerts.md and the existing Telnyx API helper. Messaging profile `dispatch-sms` has an Alpha sender. If a new secret or env var is needed, use a name only and list it in your report (the owner adds the value; never put a value in any file).
- Recipient: technician number from TECH_PHONES_JSON, normalised to international format, same +61 allow-list and premium deny list as the ring.
- Flag `sms_mode` in the DirectoryActor, same pattern as `ring_mode`: off | dry_run | live; missing or any other value = dry_run. `/admin/seed` must be able to set it. dry_run logs `sms_dry_run` with the message length only.
- Cap: SMS_DAILY_CAP (default 20). Over cap: skip and log `sms_capped`.
- A failed or skipped SMS never changes the accept outcome or the dispatched state, never throws, never blocks the confirmation speech. Log `sms_sent` / `sms_failed` with outcome and HTTP status class only.
- Privacy: no phone number, name, address or message body in any log, error or job-state output. Store only `sms_status` (sent | dry_run | off | capped | failed) and `sms_at` on the job; expose both in /admin/job-state.

## Tests (new file `tests/acceptsms.test.ts`; never edit or overwrite another test file except the brief-builder tests listed above)
- reducer: accept produces `sms_details`; decline, no-answer and hangup do not.
- runner: live sends once with the right recipient and a body containing the reference, name, callback number and address; dry_run and off do not call the API; capped skips; API failure/throw leaves the accept intact and sms_status `failed`.
- allow-list: non-+61 or premium number is not sent.
- logs: a scan of captured log lines contains none of the phone number, name or address.
- brief: contains address and reference; contains neither the name nor any digits of the callback number.
Report the new total (must be at least 302 plus new tests).

## Token budget (strict, balance is low)
Read only: D20b-sms-alerts.md, the brief builder, the ring reducer and runner, the Telnyx API helper, the DirectoryActor flag code, tests/acceptsms.test.ts pattern from one existing runner test. No repo exploration. While iterating run only the new and changed test files; run tsc once and the full suite once at the end (`env -u MCP_TOKEN -u ADMIN_TOKEN -u TELNYX_API_KEY`). Do not touch docs except one line each in docs/verify-log.md (V-023: SMS on accept, live result pending) and docs/decisions.md (D20b-1). Report only: new test total, changed tests, new env/secret names, `git status --short`, one line on anything unexpected. Do not commit.

## Live check (the owner runs it)
Set `sms_mode` to dry_run first and run one job: expect `sms_status: dry_run`. Then live: press 1 and the text arrives on the technician phone; job-state shows `sms_status: sent`.
