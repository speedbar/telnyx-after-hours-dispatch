# D20b-2: natural spoken wording + RING_VOICE switch

## Why
D20b-1 shipped the SMS. Owner feedback on the live call: it sounds robotic. D20b-1 did not implement the RING_VOICE part of its task (grep for RING_VOICE in src finds nothing) and the owner now wants different wording. This slice is small. Do not touch SMS logic.

## Wording (templated, no LLM). Replace the current texts with exactly these (business name from existing config, not hard-coded twice)
- Brief: "Hi, {business} dispatch. {Urgent|Routine} {trade} job in {suburb}, {house number} {street}. Press 1 to accept, or 2 to decline."
  - Say the house number as a normal number ("12"), never spaced digits. Do not speak the reference, customer name or any phone number. Do not mention the text message in the brief.
  - If a field is missing, drop that fragment cleanly (no "undefined", no double commas). Keep the existing length cap and injection-safe handling of the address.
- After press 1 (accept confirmation): "Thank you. The customer details will be sent to you by text message. Goodbye."
- After press 2 (decline): "No problem, thank you. Goodbye."
- Keep every other prompt unchanged (no key pressed, invalid key, timeout, voicemail handling as they are today). Only plain text with commas and full stops: no SSML, no tags.
- The accept confirmation must still be followed by the existing hangup and the sms_details effect, in the same order as today.

## RING_VOICE
Where the speak and gather_using_speak commands are built (find them in src/lib or the Telnyx API helper), add an optional `voice` field set from env `RING_VOICE` ONLY when it is a non-empty string. When unset, the request body must be byte-identical to today. Do not choose or hard-code a voice. Add `RING_VOICE` (name only, optional) to .env.example. If the language parameter is already sent, leave it as is.

## Tests (new file tests/ringwording.test.ts; do not overwrite any existing test file)
- brief contains suburb, house number as a normal number, "Press 1 to accept, or 2 to decline"; contains no spaced single digits, no reference, no name, no digit run of the callback number, no mention of text/SMS.
- missing suburb/street/trade: clean text.
- accept confirmation and decline confirmation text exactly as above.
- RING_VOICE unset: speak body unchanged and has no voice key; set: body has voice with that value.
List every existing test you had to change (expected: the D20b-1 brief tests and any test asserting the old confirmation text). Report the new total (must be at least 312).

## Token budget (strict)
Read only: src/lib/brief.ts, the ring runner file where confirmation speech is built, the Telnyx API helper that sends speak commands, tests/brief.test.ts, .env.example. No repo exploration. While iterating run only the new and changed test files; tsc once; full suite once (`env -u MCP_TOKEN -u ADMIN_TOKEN -u TELNYX_API_KEY npm test`). No doc edits except one line in docs/decisions.md (D20b-2). Report only: test total, changed tests, new env names, `git status --short`, one line on anything unexpected. Do not commit.

## Live check (the owner)
Ship, set RING_VOICE if wanted (`telnyx-edge secrets add`, then ship again), one live job: brief and both confirmations sound natural; press 1 gives the thank-you line and then the call ends; the text arrives.
