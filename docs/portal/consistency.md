# Consistency: prompts, schema, code, /dv (cfg-6, pending paste; live is cfg-5)

## 1. Prompt vs tool schema vs code

Schema source: `src/tools/index.ts`. Values the model must use exactly.

| Item | Schema / code | Where prompts say it | Match in cfg-6 |
|---|---|---|---|
| `reserve_technician` fields | customer_name, address, callback_number, urgency, trade, suburb, summary (all required) | Reserve node | yes (names copied) |
| `urgency` values | emergency, urgent | Assistant step 1, Triage | yes (cfg-2 also offered ROUTINE: fixed) |
| `trade` values | plumbing, electrical, gas, hvac, other | Assistant step 1, Triage | yes (cfg-2 omitted hvac: fixed) |
| `create_job` fields | customer_name, address, details required; contact_phone, hazards optional; job_id and call_ref ignored | Job node | yes (names copied; contact_phone named) |
| `release_technician` reason | declined, no_answer, caller_hung_up, error | Fallback | yes |
| Failure shape | ok false, reason, next "fallback", retry false, bad_fields | Assistant step 6 (owner), Reserve, Job, Fallback | yes (step 6 added in cfg-5) |
| Reference to speak | `reference_spoken` from create_job, only when `ok` is true | Assistant step 5, Job (never in Fallback) | yes |
| `/dv` variables | caller_known ("true"/"false"), customer_name, customer_address, fallback_number_spoken (`src/routes/dv.ts`) | Details uses the first three by name; Fallback templates the last | partly: see P1 |
| `lookup_customer` | in repo, not allowed in Portal | none | yes |

## 2. Rule: who decides what

| Decision | Owner |
|---|---|
| What the caller hears, order of questions | Assistant instructions (nodes mirror) |
| Which tool to call and with what words | Assistant step 5 and Reserve/Job nodes |
| Whether the data is acceptable, urgency floors, which technician | Code (S1.8), never the prompt |
| Whether the call proceeds when the system is down | Code returns next:"fallback"; prompt only reads it |
| Ending the call | Job node (success), Fallback/Close/Hang Up (failure); assistant step 6 repeats the failure ending because the model often runs the whole call from one node |

## 3. Repeated rules (change all together)

| Rule | Repeated in |
|---|---|
| Urgency and trade definitions | Assistant step 1, Triage |
| Address once, read back once, wait for yes | Assistant step 2 and "Read back one item at a time", Details |
| Number read back once, groups 4-3-3 | Assistant callback paragraph, step 3, Details |
| Scope redirect and abuse handling | Assistant (owner), Triage (pointer only) |
| Tool field lists for reserve_technician and create_job | Assistant step 5 (owner, always in force), Reserve, Job (mirrors) |
| Reference, logged line, goodbye, hangup | Assistant step 5, Job |
| One goodbye only, last words, never with a question | Assistant, Job, Close (Close only after Fallback) |
| Failure: sorry line, triple zero if emergency, office number, no reference, no callback promise, no further tool except release_technician | Assistant step 6 (owner), Fallback (mirror) |
| Reserve only after a yes to the callback read-back; create_job only if reserve returned ok; no tool in a message with a question | Assistant step 5 (owner), Reserve, Job |
| Never offer a number the caller did not say | Assistant Facts |
| Use each tool once; the only retry is `reserve_technician` after `bad_fields` includes `callback_number` | Assistant steps 5 and 6, Reserve, Job, Fallback |
| Hazards omitted when none | Assistant last line, Job |
| Gas line fires on "gas" with "smell" or "leak" even if unclear (line text unchanged, D18) | Assistant Safety only |
| Unclear hazard answer: one simpler re-ask, then hazards left out | Assistant step 4 (owner), Details |
| Never write TBC, unknown or N/A in any tool field | Assistant Facts (owner), Reserve, Job |
| Addresses spoken in words, sent to tools in digits | Assistant Addresses (owner), Reserve, Job |
| `release_technician` only if `reserve_technician` returned ok earlier | Assistant step 6 (owner), Fallback |
| Success closing line is "Your job is logged." only | Assistant Promises and step 5 (owner), Job |
| No promises of technician, time, dispatch | Assistant (Promises, "Never say you will arrange"), Reserve, Job, Fallback |

## 4. Findings and pending changes

| ID | Finding | Status |
|---|---|---|
| F1 | Triage defined ROUTINE but the tool only accepts emergency or urgent. A "routine" value would be rejected and the caller sent to Fallback. | Fixed in cfg-3 (T1) |
| F2 | hvac missing from Triage trade list although the schema has it | Fixed in cfg-3 |
| F3 | Assistant order said "urgency, trade and suburb" first while Triage said do not ask address. Live gas call asked suburb, then address, then name. | Fixed in cfg-3 (A1) |
| F4 | Node text used loose words ("callback number", "problem") while the schema says callback_number, contact_phone, details. contact_phone was once omitted. | Fixed in cfg-3 |
| F5 | Gas smell sent in `details`, not `hazards` | Fixed in cfg-3 (hazards example) |
| F6 | STT mangled "my gas" into "McGaz"; model wrote "Gas meter (McGaz)" | cfg-3 Facts sentence; same class as BUG-023 |
| F7 | Sink call "flooding very heavily" went to the tool as `urgent` | Prompt step 1 fixed it in cfg-3 (flood call JAB8CX sent `emergency`). Code floor in S1.8 stays as the real guard. |
| F9 | Caller correction ignored: "Leven King Street" saved after the caller said it was wrong (STT misheard "Eleven"). | Fixed in cfg-4 (corrections rule). STT mishearing itself cannot be fixed in the prompt. |
| F10 | `create_job` sent without `contact_phone` in 1 of 2 cfg-3 calls. Job node text was not active because the call never left Details. | cfg-4 puts the tool fields in assistant step 5. S1.8 (callback stored at reservation) is the code fix; run it. |
| F11 | No failure rule at assistant level. After `reserve_technician` returned `ok:false` the model called `create_job` anyway and said "Your job is logged". The model runs the whole call from one node, so the Fallback node text never applies. | cfg-5: assistant step 6. Evidence: chat G-01 run 1 (`1f70dc67`), H-02 run 3 (`f3b3d21b`). Note: in chat the failure was caused by the missing call_ref (F15), but the model behaviour after a failure is real and would repeat in production. |
| F12 | `reserve_technician` called in the same message that asked "is that number correct?" | cfg-5: step 5 (reserve only after a yes to the read-back; never a tool in a message with a question). Evidence: H-01 run 1 (`cf2583c2`). |
| F13 | Goodbye appended to a message that asks a question ("is that correct? ... Goodbye.") | cfg-5: one goodbye, last words, never with a question. Evidence: H-02 run 3. |
| F14 | Model offered a made-up number ("0-4-1-2, 3-4-5, 6-7-8") as the caller's number when the caller number variable was blank. Chat only (web call asked correctly). | cfg-5: Facts guard. Cheap, no downside. |
| F15 | Text chat sends no `_meta.telnyx_conversation_id`, so `call_ref_source` is `none` and every tool call is rejected with `invalid_input`, `bad_fields:["call_ref"]`. Voice and Portal web calls send it (`call_ref_source` `meta`). | Not a production bug. Chat tests cover argument shape, order and failure-path behaviour, never the success path. Success path is tested by web call or voice. |
| F16 | Fallback said someone would call back and read a job reference, but nothing is recorded when the tools fail (BUG-008 class: a promise the system cannot keep). | cfg-5: "Please call our office on <number>". Wording to be confirmed by Nabeel before paste. |
| F17 | Gas safety line skipped after STT inversion ("I can't smell the gas", "Gas mail"). The model never said the line although cfg-5 has it. | cfg-6: line also fires on "gas" with "smell" or "leak", even if unclear. Evidence: call JAPJ3S, 20 Nov. The line text still needs the licensed-tradesperson review (D18). |
| F18 | Unclear hazard answer was not re-asked; hazards not stored. Urgency still raised by the code floor (`urgency_raised`). | cfg-6: step 4 and Details re-ask once in simpler words, then leave hazards out. Evidence: call JAPJ3S. |
| F19 | Closing line "our team will call you back" promises a callback nothing triggers (repeat of F16). | cfg-6: "Your job is logged." only. Option B (alerting the on-call technician) only after D20 ships and a call proves it (cfg-7). Evidence: calls JA7M5V, JAPJ3S. |
| F20 | `release_technician` called with nothing reserved (2 of 21 chat runs, cfg-5). | cfg-6: only if reserve returned ok earlier; Fallback mirrors. |
| F8 | Project doc 19 (workflow build sheet) is stale: Hang Up off in Triage, per-node MCP tool scoping, ROUTINE, {{call_ref}}, Reserve remembering technician name | Superseded; banner added |
| P1 | `caller_known`, `customer_name`, `customer_address` are written as plain words in Details, not as `{{caller_known}}` etc. Only `fallback_number_spoken` is templated. Unless Telnyx injects all dynamic variables itself (VERIFY), the known-customer greeting cannot work. Web test calls never show it because the caller number is blank. | Pending. Needs a real-number call to test. Proposed line for the top of Details: `Caller record: caller_known is {{caller_known}}, customer_name is {{customer_name}}, customer_address is {{customer_address}}. If any of these show template text or are empty, treat the caller as unknown.` |
| P2 | S1.8 makes a bad callback number a hard reject. Reserve said "no second attempt", so one slip became the Fallback apology. | Applied in cfg-6 (assistant step 6 and Reserve): one retry only. S1.8 itself is merged. |
| P3 | Failure path partly seen in chat (F11): the model skipped Fallback entirely. Still untested by voice: Fallback, Close, Hang Up. | After cfg-5 is pasted, run the failure drill by voice (flip `flag/dispatch_enabled` to false, one call, flip back). Then fix with evidence. |
| P4 | The line "One moment, I'm just checking that now." is not the model. It is the Portal's MCP filler message (Integrations section): type "On delayed response", delay 1500 ms. It fires whenever a tool takes longer than 1.5 s, so it plays on most `reserve_technician` calls (1.1 to 1.6 s). | Resolved: recorded in `assistant.md`. Leave as is. It should stop firing once S1.9 brings reserve under 1.5 s; decide then whether to keep it for slow tools. |
| P5 | The gas transcript text contains `<emotion value="calm" />` and `<break time="0.4s" />` tags the model emitted on its own. They are in no prompt. If the voice does not interpret them they may be spoken. | Ask the tester whether she heard them. VERIFY. |
| P6 | First-token stall of 3.86 s on one sink turn (end-user perceived 4.05 s), 1.7 to 1.9 s before the tool calls. GLM-5.3-Flash variance. | Faster model on Triage/Details as an experiment, VERIFY options. Not before prompts are frozen. |
| P7 | Closing line B: say we are alerting the on-call technician. | After D20 (technician ring) ships and a call proves it. Then cfg-7. |
| P8 | Idea (Nabeel, 20 Nov): text the caller their job ID. | Stretch, after D20 and D20b. Guards if built: send only to the calling number, once per job, capped; alpha sender shows as "Unverified" in AU (VERIFY). |

## 5. Edits to paste now (live cfg-5 to cfg-6)

Paste whole blocks, in this order, then save as a new version named `cfg-6 gas trigger, hazard re-ask, reserve retry`:

1. Assistant: whole Instructions block from `assistant.md`.
2. Details node: whole text from `nodes.md`.
3. Reserve node: whole text from `nodes.md`.
4. Job node: whole text from `nodes.md`.
5. Fallback node: whole text from `nodes.md`.

Triage, Close, Hang Up, the seven edges and the tool toggles are unchanged from cfg-5. After pasting, read it back (section 6).

Before pasting: run the conversation golden set on cfg-5 (`npm run chat-test -- --repeat 3`) for the baseline. After pasting, rerun. Scenario-only fixes first (T1.0e): callback_number any-of ["0400 123 456","0400123456"]; confirm routes add "is that"; hazards routes add "smell gas", "water near", "near the electrics", "appliances"; keep the urgency=emergency assertion. New assertions: closing line contains no "call you back"; `release_technician` not called when reserve returned ok false.

Voice calls after paste: (1) gas call that says "smell" (expect the scripted gas line once, exactly); (2) a call with an unclear hazard answer (expect one re-ask, then continue); (3) the failure drill: flip `flag/dispatch_enabled` to false, one call, flip back, to see Fallback by voice for the first time.

## 6. Read-back checklist after any Portal save

1. Assistant Instructions equal `assistant.md` (compare the numbered steps and the last six lines).
2. Each of the five prompt nodes equals `nodes.md`; Instructions Mode is Append; LLM is assistant default.
3. Seven edges and their texts equal `edges.md`; no Job to Close edge.
4. Tool toggles equal the table in `edges.md`; Hang Up ON everywhere.
5. MCP allowed tools are exactly the three listed; `lookup_customer` unticked.
6. Run one sink call and one gas call; compare with the pass criteria below.

Pass criteria for a call: correct urgency and trade; address with house number read back once; number read back once, digits correct; no unscripted advice; hazards sent only when present; reference read once; one goodbye; call ends; no dead air over 2 s.

## 7. Evidence by test round (latest)

| Call | Node the whole call ran in | Result | Notes |
|---|---|---|---|
| JAV3QX (sink) | Details | Data correct, one goodbye, hangup | Urgency `urgent` for heavy flooding (F7). Filler line before tools. 3.86 s first-token stall once. reserve 1228 ms (over budget). |
| JAPQMV (gas) | Triage | Data correct except "meter" invented, one goodbye, hangup | Scripted gas line said once, exactly. Suburb asked before address (F3). Hazard in details only (F5). reserve 1617 ms. |
| Earlier JAKHT7, JA3PZG | Details / Triage | See bug journal | lookup_customer called once with a SIP address; now unticked, not seen again. |
| JAB8CX (flood, cfg-3) | Triage then Details | PASS on every criterion | emergency and plumbing correct. Address one question, read back once. Name and number in one question. Hazard asked, none sent. Reference, one goodbye, hangup. reserve 1627 ms (filler played). |
| JAFHAE (gas, cfg-3) | Triage then Details | FAIL on two: wrong address saved, no `contact_phone` | Gas line once, exact. Hazards sent as `hazards` (F5 fixed). Edge Triage to Details fired in both cfg-3 calls. Latency for this call not captured: re-pull logs. |

| Voice web call, gas (cfg-4, 20 Nov) | Triage then Details | PASS on the success path | Gas line once, hazards sent, reference, hangup. Hangup came after the goodbye audio finished playing (about 10 to 12 s), not instant. A 2.4 s gap after the caller's "Yeah" was assistant-side tool latency (S1.9, BUG-005); the 22 s opening silence was the caller not speaking. The "Leven" correction was not exercised. |
| Voice web call, cleaning request (cfg-4, 20 Nov) | Triage | PASS (E-01) | Polite redirect to business hours, goodbye, hangup, no tool calls. |
| Chat golden set, cfg-4 (20 Nov) | n/a | Partly red, expected | Tool calls always rejected for call_ref (F15). Real model defects found: F11 to F14, F16. |
| Voice call JAPJ3S (gas, cfg-5, S1.8 build, 20 Nov) | Triage (zero transitions) | Success path completed; FAIL on the gas safety line and on hazards | STT heard "I can't smell the gas" and "Gas mail": the gas line was never said (F17); the unclear hazard answer was not re-asked, hazards not stored (F18); code raised urgency (`urgency_raised`); closing line promised a callback (F19). The address correction worked. `reserve_technician` took 1080 to 1633 ms across the last three calls (S1.9). |

Latency, all calls: `/dv` 496 to 573 ms; `reserve_technician` 1.1 to 1.6 s every call (BUG-005, S1.9); `create_job` 357 to 429 ms.

## 8. Change log

| Date | Version | Change | Reason |
|---|---|---|---|
| 19 Nov 2026 | cfg-2 | Live state when first read back: node texts, 7 edges, Hang Up ON, lookup_customer unticked, no Job to Close edge | Rounds 6 to 9 |
| 19 Nov 2026 | cfg-3 | Assistant order as numbered steps with urgency and trade definitions; Facts sentence on unclear words; Triage urgency and trade values aligned to schema; Reserve and Job use schema field names; hazards example | F1 to F7, calls JAV3QX and JAPQMV |
| 20 Nov 2026 | cfg-4 | Corrections rule; step 5 lists tool fields; scope and abuse paragraph; Triage scope pointer | F9, F10, call JAFHAE; edge-case review (`docs/edge-cases.md`) |
| 20 Nov 2026 | cfg-5 (live) | Assistant step 6 failure rule; step 5 reserve after yes, create_job only if reserve ok, no tool with a question; one goodbye rule; never offer an unsaid number; Job node ok guard; Fallback wording (sorry line, triple zero, office number, no callback promise, no reference) | F11 to F16, chat runs `cf2583c2`, `1f70dc67`, `f3b3d21b` |
| 20 Nov 2026 | cfg-6 (pending paste) | Gas line also fires on "gas" with "smell" or "leak", even if unclear; unclear hazard answer re-asked once; closing line "Your job is logged." only; one callback_number retry in step 6 and Reserve; `release_technician` only if reserve returned ok; never TBC, unknown or N/A; addresses spoken in words, sent as digits | F17 to F20, call JAPJ3S |
