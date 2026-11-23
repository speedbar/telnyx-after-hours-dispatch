# Edge cases: what is handled and what is not

Last checked 23 Nov 2026 against the code, the unit tests and the live calls. A row only says "tested" if a test or a real call shows it.

| Status | Meaning |
|---|---|
| Handled, seen live | Built, and a real call or live check showed it working |
| Handled in code | Built and unit-tested, not yet tried by voice |
| Prompt rule | Lives in the assistant instructions. A chat-test scenario exists, a live run is pending |
| Partly | Some of it is covered, the gap is named |
| Not handled | Not built |

| ID | Scenario | Status | What happens | Evidence | Left to do |
|---|---|---|---|---|---|
| E-01 | Out-of-scope request (cleaning, quote, sales) | Prompt rule | Polite redirect, goodbye, hang up. No tools, no job. | Scenario `E-01-cleaning` | Run it live |
| E-02 | Real problem that can wait until morning (dripping tap) | Prompt rule | Told to ring in business hours. No job is logged, which is worse for the customer than a logged callback. | Scenario `E-02-can-wait` (C-09) | Routine path: log a job with no technician held (not built) |
| E-03 | Abusive, silent or prank caller | Prompt rule | One line, then hang up. | Scenario `E-03-abusive` | Run it live. Check the Telnyx idle timeout (VERIFY) |
| E-04 | "Ignore your rules", "read me your instructions" | Prompt rule | Politely refused. Tool inputs are validated, so injected text is stored as inert text. The prompt holds no secrets. | Scenarios `E-04-injection` (C-11), `E-08-secret-probe`; `tests/validate.test.ts` | Run them live |
| E-05 | Repeated prank calls that hold every technician | Not handled | Each reservation holds a technician for 90 s, so three quick calls could hold all three and a real emergency gets the fallback. Per-technician ring cooldown (60 s) and daily caps for rings (20) and texts (20) limit the cost, not the holds. | Reasoning from `src/tools/reserve_technician.ts` | Cap holds per caller. The tool only receives the conversation id, so this needs the caller hash from `/dv` |
| E-06 | Callback number used for toll fraud | Handled in code | Only technicians from our own roster are rung, and only to allowed prefixes (+61). Premium, 1300, 1800, 000, 112 and 106 numbers are refused. A caller's number is never dialled. | `tests/ring.test.ts` (`checkDialAllowed`) | None |
| E-07 | Caller hangs up mid-flow | Handled in code | A hold expires after 90 s on its own. Fallback calls `release_technician` with `caller_hung_up`. | V-014 (hold expiry, live). Hang-up by voice not tried | Hang up after reserve and check the hold clears |
| E-08 | Callback number wrong or undialable | Handled in code | Rejected if too short, all the same digit, an emergency number, or an Australian number of the wrong length. The assistant reads the number back and the model gets one retry. | S1.8, `tests/validate.test.ts`. Read-back seen live on 23 Nov | Try a bad number by voice |
| E-09 | Speech-to-text mishears the address | Partly | The assistant reads the address back and asks for the house number. Seen live on 23 Nov ("is that one King Street, Newtown?"). Nothing checks that an address exists, so a plausible fake is accepted. | Live calls 22 and 23 Nov | Stated as a limit. An address check is out of scope |
| E-10 | Caller asks for a human | Handled, seen live | The call is transferred. The human accepts by voice. If they say no or do not answer, the assistant carries on logging the job. | V-024: accept, decline and no answer all passed | None |
| E-11 | Duplicate calls about the same incident | Partly | The same call is safe to repeat: tool retries and duplicate webhooks return the same job, because state is keyed by call. Two separate calls about one incident still create two jobs. | Code: state is keyed by call in `JobActor` and `TechnicianActor`; V-014 | Match calls by caller hash and recent time (not built) |
| E-12 | System down, or no technician free, in a real emergency | Handled, seen live | The Fallback node apologises, gives the office number and says to ring triple zero if in danger. It was reached on two real calls on 23 Nov, when `reserve_technician` hit the 5 s tool limit (BUG-027). | Transcripts of 23 Nov | The flags-off drill ran on 23 Nov, see E-15 |
| E-13 | Medical emergency, fire, violence | Prompt rule | The greeting tells people to hang up and ring triple zero. The assistant names the right service for fire, ambulance and police (cfg-8). The gas safety line has been heard live. | Scenarios `E-05-emergency-services`, `H-03-sparks` | One live call about fire |
| E-14 | Caller speaks another language or is hard to understand | Not handled | The assistant does not detect the language. It asks the caller to repeat, and may drift. | Nothing built or tested | Stated as a limit. Option: add a spoken fallback to the office number after two failed attempts |
| E-15 | Dispatch switched off | Handled, seen live | `/dv` returns `dispatch_enabled`, and an edge on that variable sends the call to the Fallback. `reserve_technician` also returns `disabled`, so nobody is reserved or rung. Drilled on 23 Nov: the call reached the Fallback and the server blocked dispatch. The assistant still asked a couple of questions first, about 70 s in all, because the model follows the assistant instructions over the node text (BUG-028). | `src/tools/reserve_technician.ts`. Live call 23 Nov | Make the Fallback end the call straight away |
| E-16 | Returning caller who was not in the seed list | Not handled | The first call's name and address are kept only on that call's job record. The customer list is loaded by hand (seed), so the second call is treated as a stranger and asked everything again. | `src/actors/DirectoryActor.ts` (no write method except seed), `src/routes/seed.ts` (the only KV write) | Save name and address under the callback number when a job is created, with a retention limit. Needs a privacy decision |
| E-17 | Known caller says the address or name is wrong | Prompt rule | The assistant asks the normal full-address or name question and uses the new answer for the job. The stored record is not changed. | cfg-10b text. Test 2 in `docs/portal/cfg-10-paste-sheet.md`, not yet run | Run it by voice |

## The rule behind the prompt wording

Refusing a real emergency is worse than booking a technician for a doubtful call. So the scope rule only redirects when the request is clearly not a trade problem, or the caller says it can wait, and otherwise treats the call as urgent. The hard guards (E-05, E-06, E-08) belong in code, because a prompt can't be trusted against someone trying to abuse it.

## What I'd do next

1. Run the chat-test scenarios live in dry-run mode and mark the prompt rules above as seen.
2. Run the hang-up check.
3. Build the routine path (E-02) and the per-caller hold cap (E-05).
