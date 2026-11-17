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
