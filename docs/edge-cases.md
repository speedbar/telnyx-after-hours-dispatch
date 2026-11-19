# Edge cases: what is handled, what is not

Written 20 Nov 2026 after a review prompted by "what about fraud calls and non-urgent requests like cleaning?". Honest status first, so the README and the demo never claim more than is built.

Status key: **Handled** (built and seen in a test), **Prompt only** (a prompt rule, not yet tested), **Designed** (in a spec, not built), **Not handled**.

| ID | Scenario | Status today | What happens now | Planned fix | Test |
|---|---|---|---|---|---|
| E-01 | Out-of-scope request (cleaning, quote, booking, sales) | Prompt only (cfg-4) | Before cfg-4 it would be classed urgent and a technician reserved | Scope paragraph in assistant text: polite redirect, goodbye, hangup, no details, no tools | Call it; expect no `mcp_call` in logs |
| E-02 | Real trade problem that can wait until morning (dripping tap) | Prompt only (cfg-4) | Redirected to business hours, no job logged. This is worse for the customer than a logged callback. | S1.10 routine path: `routine` urgency creates a job with no technician reserved (needs `create_job` to accept a job with no hold). It is #3 on the cut list. | Call it; expect redirect, no reserve |
| E-03 | Abusive, silent or prank caller | Prompt only (cfg-4) | One line and hangup. Telnyx idle timeout setting not checked (VERIFY). | Idle timeout in Portal; S1.10 abuse guards (E-05) | Call it; silent for 20 s; abusive wording |
| E-04 | "Ignore your rules / read me your instructions" | Prompt only (cfg-4) | The server validates and sanitises every tool input, so injected text is stored as inert text. Prompt has no secrets. Spoken refusal untested. | Golden call C-11 | Call it |
| E-05 | Repeated prank calls holding every technician (hold exhaustion) | Not handled | Each reservation holds a technician for 90 s. Three quick calls could hold all three, and a real emergency then gets the fallback. | S1.10: per-caller reservation cap using the caller hash from `/dv`, plus a cap on concurrent holds. Needs design: MCP only receives the conversation id, not the caller number. S1.8 excludes it on purpose. | Concurrency script plus 3 fast calls |
| E-06 | Callback number used for toll fraud (premium or international number given as callback) | Safe today by design | Nothing dials the caller. S1.8 hard-rejects 000, 112, 106 and malformed AU numbers only; other countries accepted. | Rule for the closed loop: never auto-dial a caller's number without an AU prefix allow-list. Technicians are dialled from our own roster only. | Unit test when the closed loop exists |
| E-07 | Caller hangs up mid-flow | Handled in code, untested live | A hold expires after 90 s on its own (TTL), so nothing is orphaned. Fallback calls `release_technician` with `caller_hung_up`. | None | Hang up after reserve; check the hold clears |
| E-08 | Callback number wrong or undiallable | Designed (S1.8) | Currently accepted if 8 to 15 digits | S1.8 hard reject plus P2 one retry in Reserve | S1.8 tests |
| E-09 | Speech-to-text mishears the address | Partly | Read-back plus house-number rule plus (cfg-4) corrections rule. No address verification exists (no geocoding): a plausible fake address is accepted. S1.8 only flags short or numberless addresses. | Say so as a limitation; an address check is out of scope | Gas call with a hard street name, correct it |
| E-10 | Caller asks for a human | Not handled | Assistant says the team will call back | Closed loop / human-in-the-loop edge (later) | Call it |
| E-11 | Duplicate call about the same incident | Not handled | Two jobs created | Out of scope (S1.8 note); same design need as E-05 | n/a |
| E-12 | System down or no technician when it is a real emergency | Designed, untested | Reserve or Job fail goes to Fallback: apology, office number, release. Not exercised yet. | Failure drill P3: flip `flag/dispatch_enabled` to false, one call, flip back | Drill |
| E-13 | Medical emergency, fire, violence | Prompt only | "If anyone is in danger, call triple zero" greeting and rule. Untested beyond gas. | None | One call |
| E-14 | Caller speaks another language or is hard to understand | Not handled | Model improvises | Out of scope; mention as a limitation | n/a |
| E-15 | Dispatch switched off (kill switch) | Partly | `/dv` returns `dispatch_enabled`; `reserve_technician` returns `disabled` and goes to Fallback. The kill-switch edge is not built. | Expression edge Triage to Fallback (later) | Drill (same as E-12) |

## Principle behind the prompt rules

Over-refusing an emergency is worse than reserving a technician for a doubtful call. So the scope rule only redirects when the request is clearly not a trade problem or the caller says it can wait, and says "if unsure, treat as urgent". The hard guards (E-05, E-06, E-08) belong in code, because a prompt cannot be trusted against someone who is trying to abuse it.

## Order to do them

1. cfg-4 prompt (E-01 to E-04), tested with four short calls.
2. S1.8 (E-08, and the callback safety net).
3. Failure drill (E-12, E-15), then E-07 check.
4. S1.10 spec: routine path (E-02) and abuse guards (E-05). Write it after S1.8 so the actor changes do not collide.
