# Decisions
One entry per decision: Decision / Options considered / Choice / Why / Revisit if.
Source: claude planning doc 09 section 4.2, plus decisions made while building. Where this file and an older planning note disagree, this file wins.

## D1 One umbrella function
- Options: separate functions per concern (dv, mcp, events) vs one umbrella function `dispatch`.
- Choice: one umbrella function, TypeScript, one telnyx.toml.
- Why: Stateful Actors require the umbrella project; one deploy, one URL, one log stream.
- Revisit if: bundle size or cold start becomes a problem (bundle is about 2.6 MB today).

## D2 Hand-rolled stateless MCP server
- Options: @modelcontextprotocol/sdk vs a small JSON-RPC 2.0 handler over POST.
- Choice: hand-rolled, plain JSON responses, no SSE, no sessions.
- Why: fewer dependencies in the bundle; tool-call servers over HTTP may answer plain JSON.
- Revisit if: the assistant cannot connect to it (fallback: the SDK).

## D3 Actor holds reservation truth; KV holds the rest
- Choice: TechnicianActor owns availability and holds. KV holds read-mostly or recoverable data (jobs, flags, customers, idempotency). Actors do not touch KV.
- Why: KV has no compare-and-set (last write wins), so a read-modify-write that must be exclusive belongs in an actor.

## D4 Reservation is a hold with a TTL
- Choice: default 90 s, set by DISPATCH_HOLD_TTL_S. An actor alarm expires it; every method also checks expiry lazily.
- Why: any failure path returns the technician to available. The alarm is at-least-once and can be dropped after 3 failures, so the lazy check is the safety net.

## D5 Idempotency on call_ref
- Choice: every tool takes call_ref (the Telnyx call id; sim-<uuid> from the simulator). A repeated reserve_technician with the same call_ref returns the existing hold.

## D6 Accepted and declined outcomes
- Choice: decline is handled in the call (release). Accept is reconciled by the post-call webhook; otherwise TTL expiry marks the job expired_unconfirmed. Never silently "dispatched".

## D7 Models
- Assistant model: zai-org/GLM-5.3-Flash first; switch to moonshotai/Kimi-K2.6 if tool calling is unreliable.
- Coding model (OpenCode): moonshotai/Kimi-K3 (GLM-5.2 if K3 is too slow). Kimi-K3 is not available for assistants.

## D8 Feature flags in KV
- Choice: flag/dispatch_enabled and flag/technician_pool are read by /dv and passed as dynamic variables, so edges can route on them without a redeploy.

## D9 No customer PII in logs
- Choice: caller_hash = sha256(salt + e164) first 12 hex characters; LOG_SALT is a secret.

## D10 KV key format (added 17 Nov 2026, BUG-002)
- Options: keep ":" separators (rejected by the service) vs "/" separators.
- Choice: only a-z A-Z 0-9 - _ / = . are allowed. Use "/" as the separator, drop "+" from phone numbers, and replace any other character in call ids with "_". Build every key through one helper in src/lib/ that validates the format.
- Keys: flag/dispatch_enabled, flag/technician_pool, cust/<e164 without +>, job/<job_id>, job-by-call/<sanitised call_ref>.
- Why: found by a live test route (HTTP 400, code 10015). Actor names are not affected.

## D11 Git workflow (added 17 Nov 2026)
- Choice: one short branch per OpenCode task, named after its spec; merge to main with --no-ff only after the task tests pass and a live curl works; docs-only commits go straight to main. Deploy from a branch to test; before stopping for the night, merge or redeploy from main so the live function matches main.
- Why: main stays the last known-good version and rollback is one ship away.

## D12 Architecture: managed AI Assistant with a Conversation Workflow (added 18 Nov 2026)
- Options considered: (A) Telnyx AI Assistant with a Conversation Workflow, MCP tools, dynamic-variables webhook and built-in warm transfer; (B) build the voice loop ourselves (Voice API / Call Control or a LiveKit agent using Telnyx STT, LLM and TTS); (C) an LLM plus a vector store (Telnyx embeddings / Knowledge Base / AI Search) as the core design.
- Choice: A. The brief requires the workflow, MCP and dynamic-variables pieces; the Telnyx docs say workflows suit structured processes such as intake, escalation and triage while a single prompt suits open-ended conversations; warm transfer with acceptance is an assistant feature; Telnyx's own home-services receptionist page describes the same pattern (triage, book, escalate true emergencies, transfer to a staff mobile).
- Why not B: we would rebuild turn detection, barge-in, idle handling and the transfer handshake, and lose the workflow and warm-transfer features the brief scores.
- Why not C as the core: dispatch is transactional and state-based (reserve a technician, hand off the call). Exact lookups (customer, flags, job) belong in KV and the actor, not in similarity search. A vector store answers "what do our documents say", which is not this problem.
- Where a vector store could fit: an optional FAQ knowledge base on the assistant (service area, after-hours rates, what to do while waiting). Not in the build plan; a Day 3 stretch only if everything else passes. Known unknowns: the workflows doc does not cover knowledge or retrieval scoping per node, and retrieval latency on a voice turn is unmeasured.
- Revisit if: the Portal workflow editor cannot express the flow, or Stephen asks for a knowledge-base example.

## D13 Hot-path state lives in Stateful Actor storage; KV is the off-path system of record (added 18 Nov 2026)
- Evidence: V-010 / BUG-003. KV is about 1.5 to 1.9 s per operation; actor storage is under 0.1 s.
- Choice: the /dv webhook and later the MCP tools read and write hot state (customer lookup, flags, reservations) through actors. KV keeps the durable copy (seeded and written outside the voice path, for example by the seed route and after a call ends), so KV is still used and still shows in the logs, but no caller waits on it.
- Alternatives considered: parallel KV reads in /dv (still 1.5 to 1.9 s, over the default timeout); moving the customer lookup into a workflow tool (hides the delay behind speech but loses "Hi Ada" in the first line); bundling a customer list in code (fast, but puts phone numbers in the repo).
- Revisit if: the KV latency turns out to be a tier or region setting we can change, or Telnyx documents a faster KV read mode.

## D14 End-of-turn detection (added 19 Nov 2026)
- Choice: eager end-of-turn equals the end-of-turn threshold (0.8). Why: fewer cut-offs when callers read out numbers. Revisit after live phone calls.

## D15 Delayed filler lines for MCP calls (added 19 Nov 2026)
- Choice: short filler lines at 800 ms and 2500 ms while a tool runs, so the caller does not hear silence.

## D16 Golden set in two layers (added 19 Nov 2026)
- Choice: layer 1 checks tool schemas and server behaviour deterministically; layer 2 replays scripted conversations. Status: planned, not built.

## D17 The server identifies the call and the job (added 19 Nov 2026, proposed)
- Why: the model made up call_ref and job_id (BUG-006 to 011). The server now prefers Telnyx call metadata (field names unverified, V-016), else a safe hash, and derives job_id from the JobActor record.
- Failures return next:"fallback", retry:false and the missing fields. Status: written in the working tree, not shipped.

## D18 Scripted safety wording (added 19 Nov 2026)
- Choice: fixed sentences for water near electrics and for gas, no other safety advice. Gas: do not use switches or flames, leave and call triple zero from outside. Status: pending live check and tradesperson review.

## D19 Guardrails in code, not prompts (added 20 Nov 2026, S1.8)
- Evidence: live tests 5 and 6 (19 Nov 2026) and a code review. Speech-to-text mangles caller words ("water is drying out fast" was classed `urgent`), reserve_technician ignored the job's trade when walking the pool, normalisePhone accepted undiallable callbacks, a second create_job overwrote confirmed details, and job records with personal data were kept forever.
- Choice: guardrails in code, not prompts — severity and trade floors (keywords in the summary raise urgency, never lower it), technician eligibility by licensed trade, hard reject only for an undiallable callback, soft flags for the rest (accepted job, human review), first-write-wins briefing, 7 day retention of job records via an actor alarm.
- Conservative-gas rule: any whole-word "gas" mention corrects the trade to `gas` and forces `emergency`, so a gas hot water complaint is routed to a gas-licensed technician and treated as an emergency. A false emergency beats a missed one on an after-hours call.
- Known limitation: suburb or area matching is NOT built — eligibility is by licensed trade only; a technician may be reserved for a job far away.
- Why not prompt wording: prompts are advice to the model; code is a wall. Anything with consequences (reservation, retries, safety) stays deterministic.

## D20 Technician ring: fail-safe modes, pure reducer, event-driven (added 21 Nov 2026)
- Why: after create_job, nothing told a human about the job; one technician was reserved for four jobs in 25 minutes because markBooked only silenced the hold expiry.
- Choice: a deterministic ring, no LLM. The machine is a pure reducer (state, event) -> (state, effects) with all I/O behind injected deps, so webhook retries and out-of-order events can never cause a second dial. `ring_mode` fails SAFE (missing key or any other value = dry_run, unlike dispatch_enabled which fails open) because a ring costs money and wakes a person. Hard caps in code: 2 attempts per job, a daily DirectoryActor counter, a per-technician cooldown, one ring per job. Only an explicit accept can mark `dispatched`.
- State: ring state lives in the per-call JobActor (instance name = call_ref); the actor's single alarm is multiplexed between the 7-day retention delete and the ring start (option A, spike D20-0 proved actors can fetch). Technician availability (hold, dispatched, cooldown) stays in the TechnicianActor.
- Admin: `/admin/ring-test` rings a named technician with a fake `sim-` job; the mode override there can never be "off", defaults to dry_run, and goes live only when the body says so.
- Revisit if: the 2-attempt cap or the cooldown proves too tight in the live checks (spec section 3).

## D20 addendum Ring start runs in the function, the alarm keeps only the timing (added 21 Nov 2026, D20-5e)
- Why: the first real call did not ring — the alarm-ran startRing (D20-5b option A) appeared not to see the function's ring secrets in the actor (V-020, inferred, not proven), and actor log lines are invisible (V-018), so a skipped dial was silent.
- Choice: create_job stores a random 16-byte single-use token and the absolute POST /ring-start URL (from the request origin) on the job; the alarm consumes ring_at, POSTs {call_ref, token} with a 3000 ms timeout, and stamps ring_start_reason from the response (callback_error on any failure, dispatch_state unassigned unless ok or mode_off). The route checks the token atomically in the JobActor (consumeRingToken: constant-time compare, only while the ring is idle, deleted on use) and runs startRing in the function, which has the secrets. Same 403 body for every token failure; the token is never logged or returned.
- Consequence: no shared secret is needed inside the actor; a redelivered alarm or replayed token can never start a second dial.

## D20 addendum The ring starts inline from create_job (added 21 Nov 2026, D20-5g)
- Why: live test sim-cb-2 (V-022) showed the alarm's POST to /ring-start on our own host timing out twice with no /ring-start log line — cause unproven (actor re-entrancy on the same JobActor, or actors unable to call their own public URL). The function path is proven by /admin/ring-test, so the ring no longer depends on that POST.
- Choice: create_job runs startRing inline in the function (which has the ring secrets), under a hard 3 s cap, never throwing and never failing the tool result. RingStarted on the JobActor stamps ring_start_reason and cancels the pending alarm ring (ring_at + token deleted) on a start, so a later alarm cannot dial twice — backed by the reducer's existing idle-start guard and the single-use token. The alarm + callback path is kept only as a fallback on a transient inline miss (deps_error / run_error / timeout) and behind RING_INLINE=0. RING_START_DELAY_MS applies to the alarm path only.
- Why keep the alarm at all: a hung or erroring inline start (e.g. a Telnyx API wobble inside the 3 s cap) should not silently lose the ring; the alarm is the cheap retry that already exists.
