# D20b-3: spoken urgency must match the stored value + .env.example names

## Why (found in the repo review, 21 Nov)
1. src/lib/brief.ts buildBrief maps urgency like this: "emergency" is spoken as "Urgent" and anything else (including the stored value "urgent") is spoken as "Routine". The only stored urgencies are "emergency" and "urgent" (src/tools/reserve_technician.ts URGENCIES). So a normal urgent job is announced to the technician as a "Routine" job, and an emergency as "Urgent", while the SMS prints the stored value. Wrong and inconsistent.
2. .env.example has drifted from what the code reads.

## Change 1: brief.ts
Speak the stored urgency value, first letter capitalised, nothing mapped: "Emergency plumbing job in Newtown, 12 Quay Street." / "Urgent gas job ...". If urgency is empty after cleaning, omit it ("Plumbing job ..."). No other wording changes. Keep every existing cleaning and cap rule.
Tests: new file tests/briefurgency.test.ts (emergency spoken as Emergency, urgent spoken as Urgent, never "Routine" for either, empty urgency omitted, unknown value passed through capitalised and cleaned). Existing tests that assert "Urgent" for emergency or "Routine" for urgent must be updated: list each one.

## Change 2: .env.example (names only, no values, no secrets)
- Replace MCP_BEARER_TOKEN with MCP_TOKEN (the code reads MCP_TOKEN).
- Add, with one comment line each: ADMIN_TOKEN, ALLOWED_DIAL_PREFIXES (default +61), DISPATCH_BUSY_S (default 1800), RING_COOLDOWN_S (default 60, 0 disables), RING_DAILY_CAP (default 20), RING_HOLD_TTL_S, RING_START_DELAY_MS (alarm fallback only), RING_TTS_LANGUAGE, JOB_RETENTION_DAYS. Take each default from the source; do not guess.
- RING_VOICE comment: change "unset = Telnyx default voice" to "set this; the speak command may require a voice (VERIFY)".
- LOG_LEVEL: its filtering is not implemented (TODO in src/lib/log.ts). Add the comment "not implemented yet".

## Token budget (strict)
Read only: src/lib/brief.ts, tests/brief.test.ts, tests/ringwording.test.ts, tests/acceptsms.test.ts (only the lines that mention the urgency word), src/lib/log.ts (only the TODO line), .env.example, and the one grep for default values in src/lib/ringstart.ts and src/lib/config.ts. No repo exploration. Run tsc once, then only the new and changed test files. Do NOT run the full suite; the owner runs it. No doc edits except one line in docs/decisions.md (D20b-3). Do not commit. Report only: changed tests, new test total for the files you ran, git status --short, one line on anything unexpected.
