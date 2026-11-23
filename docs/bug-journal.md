# Bug journal

Every real problem hit while building, written the same way: when and where, the symptom, the evidence, the root cause, the fix, and the signal that found it. Newest entries are at the bottom.

Best trails to read first:

- **BUG-003**, KV took 1.5 to 1.9 s per read and blew the webhook timeout. This changed the design (D13).
- **BUG-012 and BUG-020**, the workflow collapsed into one node and its edges fired unreliably, so rules that must hold moved into the assistant instructions and into code.
- **BUG-023**, a sink leak was called "urgent" after speech recognition mangled the words, which led to an urgency floor in code.
- **BUG-024**, the manager text was silently not sent.
- **BUG-027**, two calls fell back to the office number, and the per-step timers showed why in one log line.

| ID | What went wrong |
|---|---|
| BUG-001 | Server-side secret scanner rejects `telnyx-edge ship` (false positive in SDK example values) |
| BUG-002 | KV rejects keys containing a colon (and the design used colon keys) |
| BUG-003 | KV operations take about 1.5 to 1.9 s each, and some fail intermittently, so /dv blows the dynamic-variables timeout |
| BUG-004 | OpenCode run stalls after a long reasoning step on GLM-5.3 (no tool call, no file written) |
| BUG-005 | reserve_technician takes about 1 s on a new call, 0.28 s on a replay |
| BUG-006 | reserve_technician fires in the Details node, before the caller's name was asked |
| BUG-007 | Fallback loop: 11 create_job calls with invented job ids |
| BUG-008 | Fallback message claimed details were logged (false) |
| BUG-009 | Model sends the caller's SIP address as call_ref; every tool call rejected |
| BUG-010 | Model calls create_job in the Reserve node instead of reserve_technician |
| BUG-011 | Rejected tool calls hide the cause in the logs |
| BUG-012 | Workflow collapsed into the Triage node |
| BUG-013 | False technician promise |
| BUG-014 | Unscripted safety advice |
| BUG-015 | Stacked filler messages |
| BUG-016 | Assistant talked about a "SIP address" instead of asking for a callback number |
| BUG-017 | House number dropped from the address |
| BUG-018 | Invented detail in the summary ("kitchen sink" when the caller said "sink") |
| BUG-019 | Ten seconds of dead air after "Let me log that now" |
| BUG-020 | Workflow edges fire unreliably (Triage did Details' job, Job to Close never fired) |
| BUG-021 | Call never ended: Hang Up was off in the Details node |
| BUG-022 | Duplicate goodbyes |
| BUG-023 | Model classified a sink leak as `urgent` after speech-to-text mangled the caller's words |
| BUG-024 | Manager alert skipped: a "+61" number became "++61" and failed the allow-list |
| BUG-025 | The ring started by the alarm never ran: the alarm's callback to /ring-start timed out |
| BUG-026 | The assistant said its waiting line twice |
| BUG-027 | Two calls fell back to the office number: the first read of a new JobActor took 10 to 14 s |
| BUG-028 | A known caller was asked for the address and name again |

### BUG-001 Server-side secret scanner rejects `telnyx-edge ship` (false positive in SDK example values)
When / where: 17 Nov 2026, `telnyx-edge ship` (CLI v0.5.18) of the Stateful Actor scaffold "actortest".
Symptom: HTTP 422 "upload contains what looks like a secret ... index.ts:55609 (generic-api-key)".
Evidence: CLI error with the bundle line number. Rebuilt the bundle locally with esbuild (--platform=node) and read the lines around 55609: an example `token_group_id: '182bd5e5-...'` UUID in the bundled `telnyx` SDK (node_modules/telnyx).
Hypotheses ruled out: a Tailscale `tskey-auth-...` example in the same SDK was also edited, but it was not the trigger.
Root cause: false positive of the server-side secret scanner on doc-comment example values in the `telnyx` SDK, which @telnyx/edge-runtime pulls into the bundle (about 2.6 MB; it also bundles @aws-sdk/client-s3).
Fix: replaced the example UUID with EXAMPLE across node_modules/telnyx, after which `ship` succeeded. `npm install` undoes the edit, so scripts/scrub-sdk-examples.mjs runs as a postinstall hook (`npm run check:scrub` verifies).
Signal that found it: the CLI error with a line number, plus a local reproduction of the bundle.
What we would add: run `npm run check:scrub` before every ship. Open: check whether this is fixed upstream.
Status: PROVEN 17 Nov 2026, 11:40 pm Sydney. A real `telnyx-edge ship` of `dispatch` (built from the committed repo, postinstall scrub in place) was accepted by the scanner (shipped in 1m6s, no 422).

### BUG-002 KV rejects keys containing a colon (and the design used colon keys)
When / where: 17 Nov 2026, live `dispatch` function, `POST /kv-test`, which wrote the key "kvtest:ping".
Symptom: HTTP 500 from our route with `kv_error`; detail: env KV put("kvtest:ping") failed: HTTP 400, code 10015, "Invalid key format. Allowed characters: a-z A-Z 0-9 - _ / = .".
Evidence: curl output from the deployed function. The error comes from the KV service, not our code, and the same call path works for the actor (/actor-test returned ok).
Hypotheses ruled out: namespace or binding problem (the 400 names the key, and the binding resolved); expirationTtl option (the message is about the key).
Root cause: the KV service allows only a-z A-Z 0-9 - _ / = . in keys. Our design (doc 09 section 5.4) used ":" separators (flag:, cust:, job:, job-by-call:) and "+" in E.164 phone numbers, and call ids from Telnyx contain ":" ("v3:..."). The facts table (V23) did not list a key character rule, so nothing flagged it. Actor names do allow ":" (V24); only KV is strict.
Fix: use "/" as the separator in every KV key (flag/dispatch_enabled, cust/<e164 without +>, job/<job_id>, job-by-call/<call_ref sanitised>), and build all keys through one helper that validates them. Test route key becomes "kvtest/ping" (task S0.3b).
Status: FIXED and verified 17 Nov 2026, 11:52 pm Sydney (V-005): /kv-test with key "kvtest/ping" returned ok:true.
Signal that found it: a deployed test route that does a real write and read-back (a local type check cannot catch this, and `telnyx-edge dev` might not enforce it).
What we would add to catch it faster: a key-format row in the verified-facts table; a unit test that every key builder output matches /^[A-Za-z0-9\-_\/=.]+$/.

### BUG-003 KV operations take about 1.5 to 1.9 s each, and some fail intermittently, so /dv blows the dynamic-variables timeout
When / where: 18 Nov 2026, about 12:55 to 1:01 am Sydney, live `dispatch` function, `POST /dv` (S1.2) and `POST /kv-test`.
Symptom: a correctly signed /dv call returned the right variables but took 3.0 to 3.6 s (Telnyx's default webhook timeout is 1.5 s). Separately, three calls in a row for the seeded number returned `caller_known:"false"` with 200.
Evidence: dv_out latency_ms 3320 and 3022 on healthy calls; curl time_total 3.1 to 3.6 s. Three calls logged `dv_degraded` with error `lookup_failed:Error` (dv_out latency 1783, 296 and 1875 ms). GET /health took 0.08 s warm; POST /actor-test (storage get + put inside the actor) took 0.09 to 0.10 s; POST /kv-test (one KV put + one KV get) took 3.7 to 3.9 s. /dv does two sequential KV gets.
Hypotheses ruled out: network or function slowness (/health is 80 ms); Ed25519 verify or hashing (the actor route and /health are fast, the KV route is slow and /dv matches 2 x KV get); the `{ ...env }` spread losing the KV binding (the same code returned the customer on other calls, so the binding resolves).
Root cause: KV operations from the edge function cost about 1.5 to 1.9 s each. Why is unknown (trial tier, distant KV backend, or a per-request cost); VERIFY. The intermittent `Error` is a KV get throwing; its message is not yet logged (the dv log keeps the error name only, because KV errors can contain the key and the key contains the phone number).
Fix: planned in task S1.2b. Keep KV off the voice hot path. Hot state (customer lookup, flags, later reservations) lives in Stateful Actor storage, which is about 15 times faster. KV stays the system of record, written off the hot path.
Signal that found it: the dv_out latency_ms field, a curl time_total comparison across /health, /actor-test and /kv-test, and the dv_degraded log line.
What we would add to catch it faster: a latency budget per route in the spec, and a timed live call on every task that touches storage.
Status: FIXED (by avoiding KV on the hot path) and verified live 18 Nov 2026, 1:58 am Sydney (V-011): /dv now takes 14 to 31 ms server-side (curl 0.22 to 0.35 s from Sydney including TLS), down from about 3.0 to 3.6 s. The slowness of KV itself is NOT fixed and its cause is still unknown.

### BUG-004 OpenCode run stalls after a long reasoning step on GLM-5.3 (no tool call, no file written)
When / where: 18 Nov 2026, 2:05 am (task S1.3, seven files) and 3:06 am (task S1.3a, two files) Sydney; OpenCode 1.19.6, model telnyx GLM-5.3.
Symptom: after reading AGENTS.md, the spec and the listed files, the run went silent. No file was written and no further tool call appeared; about 50 minutes of waiting the first time and about 10 the second.
Evidence: both session exports end in the middle of a thinking step (59.3 s, then 41.3 s) in which the model was drafting the full implementation and tests inside its reasoning, despite a new AGENTS.md rule not to. `git status` showed a clean tree both times. Balance went $3.59 to $3.47 to $3.41 (about $0.18 for two empty runs).
Hypotheses ruled out: task too large (S1.3a was split down to two files and stalled the same way); a hung tool (no tool call was pending).
Root cause (probable, VERIFY): GLM's reasoning uses up the output allowance before it emits a tool call. The limit itself is not visible to us.
Fix: switched the same prompt to Kimi-K3. S1.3a completed in one run and passes tsc, the scrub check and all tests.
Status: WORKED AROUND. Not fixed for GLM.
Signal that found it: the human noticed the delay; `git status` and the session export confirmed nothing had been written.
What we would add to catch it faster: if no file has changed within about 3 minutes of starting a run, stop, `/new`, switch model. Compare model cost and reliability in the README.

### BUG-005 reserve_technician takes about 1 s on a new call, 0.28 s on a replay
When / where: 18 Nov 2026, 1:43 to 1:46 pm Sydney, first live test of /mcp (S1.4c) from a Sydney laptop with curl.
Symptom: tools/list 0.09 s and release 0.13 s, but reserve_technician took 1.44 s, 1.12 s, 2.60 s (second call also tried tech-02) and then 1.08, 1.03, 1.20 s on three fresh call refs. The same call replayed on an existing call ref took 0.28 s. The budget is 500 ms per tool.
Evidence: curl time_total for each call (V-015). Replay of smoke-2 0.28 s vs fresh lat-1..3 at 1.03 to 1.20 s; both paths run the same TechnicianActor reserve.
Hypotheses ruled out: route or auth overhead (tools/list is 0.09 s); cold function (repeated warm calls stayed about 1 s); technician actor itself (replay uses it and is fast).
Root cause (probable, VERIFY): the first access to a brand-new JobActor instance (its name is the call_ref, so every real call makes one) costs about 0.8 s. The slow 2.6 s call is not explained yet and may be variance.
Fix: not yet. Options: (a) cover the pause with a filler line and a longer tool timeout in the Portal (no code, free); (b) move the job record into the fixed-name technician actors so no new instance is created on the reserve path (small OpenCode spec).
Status: OPEN, mitigation (a) first; decide on (b) after the first real calls.
Signal that found it: curl time_total on each tool; the mcp_call latency_ms log field should confirm the server-side figure.
What we would add to catch it faster: a timed live call for every new route (already the rule since BUG-003), run with a fresh call_ref as well as a replay.

### BUG-006 reserve_technician fires in the Details node, before the caller's name was asked
When / where: 18 Nov 2026, live test 3, Portal assistant (Conversation Workflow) calling /mcp.
Symptom: the model called reserve_technician inside the Details node, before it had collected the caller's name, address and callback number.
Evidence: transcript row with flow_node_id "details" and a reserve_technician tool call ahead of the name question.
Hypotheses ruled out: a prompt wording slip (the Reserve node prompt was correct; the tool simply exists at assistant level); a workflow order mistake (the Details node runs first by design).
Root cause: Telnyx MCP tools are assistant-level, not per-node, so the model can call any tool in any node. Prompts cannot scope tools.
Fix (S1.5, spec items 3 and 4): reserve_technician now requires customer_name, address and callback_number, so an early call fails validation; tool descriptions say when each tool may be called.
Signal that found it: the live call transcript.
What we would add to catch it faster: a transcript review checklist against the intended node order after every live test.
Status: fixed in S1.5, pending live re-test.

### BUG-007 Fallback loop: 11 create_job calls with invented job ids
When / where: 18 Nov 2026, live test 1, fallback branch of the workflow.
Symptom: the model retried create_job 11 times in a row, inventing a job_id each time (copied from call_ref).
Evidence: Conversation History tool-call arguments; 11 consecutive failing calls.
Hypotheses ruled out: a server-side retry (each call came from the model); a workflow loop node (the model itself re-issued the tool call).
Root cause: job_id was a required model-carried input, so a model that never had one invented it, and the failure result gave no instruction to stop.
Fix (S1.5, spec items 2 and 5): job_id is read from the JobActor record (the model's value is ignored), and every failure carries next:"fallback" and retry:false so the flow has a defined way out.
Signal that found it: the live call transcript.
What we would add to catch it faster: an alert on N consecutive identical failing tool calls in one conversation.
Status: fixed in S1.5, pending live re-test.

### BUG-008 Fallback message claimed details were logged (false)
When / where: 18 Nov 2026, live tests, fallback branch.
Symptom: the assistant told the caller their details had been logged and someone would call back, but no such record existed.
Evidence: transcript wording versus the job/actor state (no record written on the fallback path).
Hypotheses ruled out: a logging bug in the server (the claim came from the spoken line, not from any write).
Root cause: the fallback prompt wording asserted an action the workflow never performs.
Fix: Portal prompt wording change only (no code). Out of the S1.5 diff by design.
Signal that found it: reading the transcript against the actual system state.
What we would add to catch it faster: a rule that every spoken claim about a side effect must map to a tool call in the same call.
Status: fixed in S1.5, pending live re-test.

### BUG-009 Model sends the caller's SIP address as call_ref; every tool call rejected
When / where: 18 Nov 2026, live test 3, all /mcp tools/call messages.
Symptom: every tool call returned invalid_input.
Evidence: tool-call arguments in Conversation History show call_ref "xxxx@sip.telnyx.com.au" instead of the "v3:..." value; our logs show invalid_input for each call.
Hypotheses ruled out: a schema rejection of other fields (the SIP address was the failing value, isCallRef rejects "@"); a missing variable (the prompt did carry {{call_ref}}).
Root cause: the model substituted the caller's SIP address for the call id, and isCallRef rejected it because "@" is not in the allowed charset.
Fix (S1.5, spec item 1): resolveCallRef prefers the tools/call _meta conversation id and otherwise accepts any non-empty string up to 200 chars, hashing it into a safe "c:" ref, so a SIP address or "v3:" string can no longer cause a rejection. isCallRef remains for the admin routes only.
Signal that found it: Conversation History tool-call arguments next to our invalid_input log lines.
What we would add to catch it faster: log the failing field names on every rejection (done in S1.5 as bad_fields).
Status: fixed in S1.5, pending live re-test.

### BUG-010 Model calls create_job in the Reserve node instead of reserve_technician
When / where: 18 Nov 2026, live test 3, Reserve node of the workflow.
Symptom: the Reserve node's tool call was create_job (with an invented job_id), not reserve_technician.
Evidence: Conversation History tool-call name and arguments in the Reserve node.
Hypotheses ruled out: wrong tool registration (tools/list is correct); the Reserve node binding a wrong tool (tools are assistant-level, see BUG-006).
Root cause: with tools assistant-level, the model picked the wrong tool for the node, and create_job accepted a model-supplied job_id to pair it with.
Fix (S1.5, spec items 2 and 4): create_job no longer takes a job_id from the model and needs an active reservation, so a wrong-node call fails as no_active_reservation; descriptions state the required call order.
Signal that found it: the live call transcript.
What we would add to catch it faster: a per-node "expected tool" check in the transcript review.
Status: fixed in S1.5, pending live re-test.

### BUG-011 Rejected tool calls hide the cause in the logs
When / where: 18 Nov 2026, live test 3 log review after the failures above.
Symptom: rejected mcp_call lines had call_ref:null and no indication of which input failed; the cause was only visible in the Telnyx transcript.
Evidence: mcp_call log lines with call_ref null and error invalid_input, nothing else; compare with the transcript which shows the SIP-address argument.
Hypotheses ruled out: logging being disabled (other fields logged fine).
Root cause: the route logged args.call_ref only when it passed isCallRef (so the failing value was dropped), and failure results carried no field information.
Fix (S1.5, spec item 5): every failure carries bad_fields (names only), the route logs the resolved safe "c:" call_ref, its source (meta|args|none), and the _meta key names seen.
Signal that found it: only by reading the transcript next to the logs.
What we would add to catch it faster: this exact fix — rejections must be self-explanatory in our own logs.
Status: fixed in S1.5, pending live re-test.

### BUG-012 Workflow collapsed into the Triage node
When / where: 19 Nov 2026, live test 4 (two calls).
Symptom: every message in both calls was labelled flow_node_id triage; reserve_technician, create_job and the closing speech came from one LLM request in call 2; call 1 jumped from Triage to Close and skipped Details, Reserve and Job.
Evidence: Conversation History CSVs for the two calls; mcp_call log lines.
Root cause (hypothesis): MCP tools are assistant-level and the Triage node still had the full toolset; the long assistant-level instructions also covered the whole task; "do not call tools" wording can stop the transition tools from firing (Telnyx workflows doc).
Fix: per-node tool override in the Portal, node texts rewritten to name only the forbidden tools, assistant-level instructions shortened.
Signal that found it: flow_node_id per message plus mcp_call logs.
What we would add to catch it faster: a log or test that checks the node sequence per call.
Status: mitigation in S1.7 and Portal changes, pending live re-test.

### BUG-013 False technician promise
When / where: 19 Nov 2026, live test 4 (call 2).
Symptom: the assistant said a named plumber was on the way with a 30 minute arrival, though no technician was contacted.
Evidence: last assistant message in the call 2 CSV; the reserve_technician result contained technician_name and eta_minutes.
Root cause: the tool result invited the promise and the Reserve node text said to remember the technician's name.
Fix: S1.7 removes those fields and tool descriptions forbid the claim; Reserve node text updated.
Signal that found it: transcript review.
What we would add to catch it faster: a golden-set check that fails any reply naming a technician or arrival time.
Status: mitigation in S1.7 and Portal changes, pending live re-test.

### BUG-014 Unscripted safety advice
When / where: 19 Nov 2026, live test 4 (calls 1 and 2).
Symptom: advice to switch off power at the switchboard (call 1) and to turn off the water supply (call 2); the scripted lines (D18) never ran.
Evidence: Conversation History CSVs for the two calls (see BUG-012).
Root cause: the call never reached the Details node where the scripted lines live (see BUG-012).
Fix: pending the workflow fix; re-test with a water-near-electrics and a gas call.
Signal that found it: transcript review.
Status: mitigation in S1.7 and Portal changes, pending live re-test.

### BUG-015 Stacked filler messages
When / where: 19 Nov 2026, live test 4 (call 2).
Symptom: the caller heard "One moment", "Thanks for waiting, I'm still on it" and "One moment" in a row, after the work had finished.
Evidence: call 2 CSV timestamps against the mcp_call latencies (reserve 1.69 s, create_job 0.44 s).
Root cause: each MCP call starts its own filler timers, two tool calls ran in one turn, and the fillers queued.
Fix: one delayed filler at 1500 ms; reserve latency (BUG-005) still to reduce.
Signal that found it: call CSV timestamps against the mcp_call latency log lines.
Status: mitigation in S1.7 and Portal changes, pending live re-test.

### BUG-016 Assistant talked about a "SIP address" instead of asking for a callback number
When / where: 19 Nov 2026, Portal web test call after the S1.7 Portal changes (job JAJ3V6; exact test number VERIFY against the CSV).
Symptom: in the Details node the assistant said it could offer "the number you're calling from" but that it "comes through as a SIP address, so I can't use it" — a garbled, technical sentence the caller should never hear.
Evidence: assistant message in the call CSV (Conversation History export).
Root cause: a Portal web call has no phone number (the caller is a SIP address), and the prompt offered the calling number without saying what to do when it is unusable. Mostly a web-call artefact, but the wording had no rule for it.
Fix: assistant instruction added: if there is no usable caller number, ask for the best number; never mention SIP or caller ID. Real phone calls carry a real number (checked on the 20 Nov calls).
Signal that found it: transcript review.
What we would add to catch it faster: a chat-test assertion that no assistant reply contains "SIP" or "caller ID".
Status: fixed in the Portal wording; no SIP talk in the next two calls; real-number calls on 20 Nov show the real caller number.

### BUG-017 House number dropped from the address
When / where: 19 Nov 2026, same call as BUG-016 (job JAJ3V6).
Symptom: the caller gave the street address in words ("two twenty six two zero two ... Crescent"); the assistant read back and saved only "2-2-6 ... Crescent", dropping part of the number.
Evidence: call CSV: the caller's words against the read-back and the reserve_technician address argument.
Root cause: the assistant-level rule to read addresses digit by digit conflicted with the Details node, and the model shortened the number. Speech-to-text may also have blurred the number (what exactly was said is not certain).
Fix: assistant instruction: repeat the address exactly as heard, in normal words ("two twenty-six"), never drop a number, ask again if unsure. Later S1.8 flags addresses with no house number (address_no_house_number).
Signal that found it: transcript review.
What we would add to catch it faster: a golden-set case with a spoken house number, asserting the digits in the tool-call address. The 20 Nov live chat run still showed house numbers written as words (open model fault, cfg-6 candidate: write house numbers as digits).
Status: fixed for the case seen; the next two calls saved "226" correctly; words-versus-digits remains a cfg-6 item.

### BUG-018 Invented detail in the summary ("kitchen sink" when the caller said "sink")
When / where: 19 Nov 2026, same call as BUG-016 (job JAJ3V6).
Symptom: the job summary said "kitchen sink" but the caller said only "sink".
Evidence: caller words against the summary argument in the call CSV.
Root cause: the model added plausible detail the caller never said (a close cousin of the earlier "McKitchon" speech-to-text finding).
Fix: assistant instruction: use only words the caller said. Later cfg-4 Facts line: write only words the caller clearly said, leave out unclear words.
Signal that found it: transcript review.
What we would add to catch it faster: a check that flags words in the summary or hazards that the caller never spoke.
Status: fixed for the case seen (the next two calls kept "kitchen sink" only when said). Recurrence on 20 Nov: the caller said "gas leakage" and the model wrote hazards "Gas smell reported" (job JA7M5V); still an open minor fault.

### BUG-019 Ten seconds of dead air after "Let me log that now"
When / where: 19 Nov 2026, Portal web gas call, re-test after BUG-016 to BUG-018 fixes (jobs JAZG45 and JA9JSD).
Symptom: after the assistant said "Thanks, Alex. Let me log that now." nothing happened for about 10 seconds; the platform injected a "[long silence]" event before reserve_technician ran. In the plumbing call, with no spoken line, the model moved on at once.
Evidence: gas call CSV timestamps and the "[long silence]" event; reserve_technician call after the gap.
Root cause: speaking that line ended the model's turn before it made the tool call, so the call waited for the caller.
Fix: Details node: delete the spoken line and say "When everything is confirmed, move on immediately. Say nothing more."; Reserve speaks nothing and the platform filler covers delay.
Signal that found it: CSV timestamps and the injected silence event.
What we would add to catch it faster: a check on call CSVs for any gap over about 3 seconds between a spoken line and the next action.
Status: fixed; the next gas call (JAZ4JB) had no dead air.

### BUG-020 Workflow edges fire unreliably (Triage did Details' job, Job to Close never fired)
When / where: 19 Nov 2026, same two web calls as BUG-019; reconfirmed on the 20 Nov real-number call.
Symptom: in the gas call Triage asked "name and address?" itself and the Triage to Details edge fired only after the callback number was confirmed; in both calls the Job to Close edge never fired and the model improvised the ending ("Goodbye for now", or just hung up) from the Job node. On 20 Nov the only transition recorded was triage to details.
Evidence: flow_node_id per message in the CSVs; the call metadata flow_transitions on 20 Nov (one transition; tools called reserve_technician, create_job, hangup).
Root cause: with GLM-5.3-Flash the LLM edges fire only if the model calls the transition tool, so they are advisory (see BUG-012). The data was still correct.
Fix: Triage text: do not ask for name, address or phone here; edge wording tightened; the Job node now says the reference, the "logged" line and the goodbye itself, and the Job to Close edge was deleted (Close and Hang Up remain for the Fallback path). The assistant-level instructions carry the whole call order. A fixed node order is no longer a pass criterion.
Signal that found it: flow_node_id per message plus transcript review.
What we would add to catch it faster: log the node sequence per call (as in BUG-012). Be ready for the question "why a workflow if the model skips nodes?"
Status: accepted limitation, mitigated and to be disclosed in the README and demo.

### BUG-021 Call never ended: Hang Up was off in the Details node
When / where: 19 Nov 2026, Portal web sink call (job JAWQ7H).
Symptom: after the goodbye the caller said "thank you" and the call continued; no hangup was called.
Evidence: no hangup tool call in the call CSV; of the last four calls only the one where Hang Up was available ended cleanly.
Root cause: the Hang Up tool was switched off in the Details node (the model ran the whole call from Details).
Fix: Portal: Hang Up ON in every node, Override tools ON only in Triage and Details.
Signal that found it: CSV review (no hangup tool call).
What we would add to catch it faster: a voice checklist item that every call ends with the hangup tool call.
Status: fixed; later calls end with hangup (gas call JAZ4JB; 20 Nov calls).

### BUG-022 Duplicate goodbyes
When / where: 19 Nov 2026, same sink call as BUG-021 (job JAWQ7H).
Symptom: the assistant said goodbye, the caller said "thank you", and the assistant said goodbye twice more.
Evidence: call CSV: three goodbyes, no hangup.
Root cause: no rule against repeating the goodbye, and no hangup (BUG-021) to end the call.
Fix: assistant instruction: after saying goodbye, do not say goodbye again; end the call with the hangup tool. cfg-5 adds: goodbye only once, as the last words, never with a question.
Signal that found it: transcript review.
What we would add to catch it faster: a chat-test assertion that the goodbye appears once (the harness already checks goodbye with a question).
Status: fixed; the 20 Nov call (JA7M5V) had one goodbye.

### BUG-023 Model classified a sink leak as `urgent` after speech-to-text mangled the caller's words
When / where: 19 Nov 2026, 05:42 UTC live call (test 5 or 6), Triage stage.
Symptom: the reserve_technician call carried `urgency: "urgent"` for what the caller said as "water is drying out fast"; nothing raised it to emergency.
Evidence: transcript of the 19 Nov 05:42 UTC call, `urgency: "urgent"` in the tool-call arguments.
Hypotheses ruled out: a prompt wording slip (the urgency rule is in the prompt and the model still got it wrong on mangled input).
Root cause: urgency was trusted from the model. Prompts cannot be the only guardrail on noisy speech-to-text.
Fix (S1.8, spec item 2): severity and trade floors in code — whole-word keywords in the summary (flood, burst, gas, sparking, ...) raise urgency to `emergency`, a "gas" mention corrects the trade to `gas`, and the model's own value is never lowered.
Signal that found it: reading the transcript.
What we would add to catch it faster: a golden-set case replaying mangled STT phrases and asserting the stored urgency.
Status: fixed in S1.8, pending live re-test.

### BUG-024 Manager alert skipped: a "+61" number became "++61" and failed the allow-list
When / where: 21 Nov 2026, about 11 pm, live test sim-dec-1 (D20c manager alert).
Symptom: the ring exhausted but no manager text arrived; the job showed manager_sms_status skipped.
Evidence: log line `sms_skipped` with error "prefix", found with `grep -E '"event":"sms_(skipped|dry_run|sent|failed|capped)"'`. A first grep for `sms_` matched every line because of the `sms_len` field.
Hypotheses ruled out: sms_mode off or capped (the mode was live and the cap was not reached).
Root cause: `toE164` in `src/lib/validate.ts` only prepends "+" to digits. MANAGER_PHONE was entered as "+61...", so it became "++61..." and failed the +61 allow-list. Unit tests used digits only, so they passed.
Fix: workaround in place, MANAGER_PHONE stored as digits with country code (retest sim-dec-2: sent). Permanent fix deferred (D20d): normalise the secret with `normalisePhone`, and correct the .env.example comment.
Signal that found it: a live test plus a log filter, not the unit tests.
What we would add to catch it faster: a unit test that feeds E.164, local and digit forms of every phone secret through the same normaliser.
Status: workaround live, code fix deferred.

### BUG-025 The ring started by the alarm never ran: the alarm's callback to /ring-start timed out
When / where: 21 Nov 2026, live test sim-cb-2 (D20-5f diagnostics deployed). Recorded as V-022.
Symptom: the technician was not rung. The JobActor alarm POSTed to /ring-start on our own public host and timed out (ring_cb_ms 8001), and no /ring-start line appeared in the function logs.
Evidence: ring_cb_error timeout, ring_cb_host correct, alarm ran as scheduled, no request line within 2 minutes.
Hypotheses: (1) actor re-entrancy, the alarm holds the JobActor while /ring-start calls the same actor. (2) an actor making an outbound call to its own host. Neither proven.
Root cause: not proven.
Fix (D20-5g): create_job starts the ring inline under a 3 s cap, and the alarm path stays only as a fallback. Cost: create_job takes about 3 s longer, masked by one filler line.
Signal that found it: a sim curl with diagnostic fields, then reading the callback timing.
Status: worked around, cause open.

### BUG-026 The assistant said its waiting line twice
When / where: 21 Nov 2026, a real call after D20-5g.
Symptom: the caller heard "please wait while I check on this" twice in one call.
Evidence: the call log: reserve_technician took about 1.3 s in code (about 2.5 s on the caller side) and create_job about 3.9 s, and each crossed the 1500 ms filler delay.
Root cause: the Portal's delay before the filler line was shorter than two normal tool calls.
Fix: delay raised from 1500 ms to 3500 ms in the Portal.
Signal that found it: hearing the call, then reading the timings.
Status: fixed. Confirmed on a live call on 23 Nov: the line is heard once.

### BUG-027 Two calls fell back to the office number: the first read of a new JobActor took 10 to 14 s
When / where: 23 Nov 2026, about 1:10 am Sydney, two live calls two minutes apart (cfg-10b test calls).
Symptom: after the caller answered the safety question the assistant said it could not log the job and gave the office number.
Evidence: the transcript shows `tool_timeout` after 5 s on `reserve_technician`. The `mcp_call` log line shows `hop_job_get_ms` 14143 and 10833 (total 14574 and 11307 ms), while `hop_flag_ms` (588, 783), `hop_tech_ms` (338, 413) and `hop_job_open_ms` (91, 59) were normal. `boot_age_ms` was about 26 hours and `first_request` was false, so it was not a function cold start. `/health` took 0.08 s.
Side effect: reserve succeeded after Telnyx had given up (jobs JAGCSJ and JAY3FM, tech-01 held, nobody rung). The holds expire on their own (hold TTL 90 s).
Root cause: not proven. The slow step is the JobActor read for a call ref that has no actor yet. Calls about 15 minutes later were fast again, so it looks like a transient slowdown in creating a new actor instance (VERIFY).
Fix: none yet. Options if it recurs: start the technician reserve at the same time as the JobActor read, and put a time limit on the read.
Signal that found it: the per-hop timers on the `mcp_call` line (S1.9), after the transcript showed the timeout.
What we would add: an alert on `latency_ms` over 4000 for tool calls.
Status: not reproduced on the next call, cause open.

### BUG-028 A known caller was asked for the address and name again
When / where: 22 Nov 2026, live call 511cb0b0 (cfg-9).
Symptom: the dynamic variables showed `caller_known` true, but the assistant asked "What's the full address" and said it had no details.
Evidence: every turn of the call had `flow_node_id` triage. The known-caller rule lived in the Details node, which never ran.
Root cause: the model runs the whole call from Triage, so node-level rules do not fire.
Fix (cfg-10): a `Caller record:` line with the variables in the assistant Instructions, and the known-caller rule moved into steps 2 and 3 of "Order of the call". Voice test on 23 Nov: the known caller heard "Is the problem at ...?" and "Am I speaking with Nabeel?", and an unknown caller was asked for their name as before.
Signal that found it: the transcript and the dv log line side by side.
Status: fixed and confirmed on a live call.
