# Demo script (8 to 10 minutes)

What the demo shows, in order, with timings. Everything shown is built and was run live. Mocked parts are named as they come up.

| # | Time | What happens | What to look at |
|---|---|---|---|
| 1 | 30 s | **The problem.** After hours, a trade business loses jobs to voicemail, and a missed emergency costs more than a false alarm. | `use-case.md` |
| 2 | 90 s | **The design.** The call path is fixed. The model talks and extracts, code decides. Walk the system diagram and the call sequence. | `architecture.md` |
| 3 | 3 min | **Live call, emergency.** Ring the number and say "my kitchen is flooding near the power points". The assistant gives the safety line, takes the address, name and number with read-backs, and reads out a job reference. The technician's phone rings, they press 1, and the details SMS arrives. | Phone, SMS |
| 4 | 2 min | **The evidence.** Show the call in Portal conversation history (transcript, tool calls, node per turn). Then the function logs and the actor logs for the same call, and `/admin/job-state` for its ring and SMS status. | `telnyx-edge logs dispatch`, `telnyx-edge actors logs TechnicianActor`, `/admin/job-state` |
| 5 | 90 s | **Failure and escalation.** A second call where the technician presses 2, then the manager gets one SMS when the attempts run out. Say what the flags do (`off`, `dry_run`, `live`) and that only `+61` numbers can be dialled. | Phone, SMS, `portal/` |
| 6 | 60 s | **A human on request.** Ask for a person on a call and show the transfer, accepted by voice. | Portal conversation history |
| 7 | 30 s | **Next.** Golden set in CI, a visible Escalate node, kill-switch and time-cap edges, a matched ring voice. | `architecture.md`, last section |

## Mocked or not built

Technicians, customers and the roster are mock data. Safety wording is scripted and needs review by a licensed tradesperson. The transfer outcome appears in Portal conversation history, not in function logs.

## Likely questions

- **Why a workflow and not one prompt?** A fixed path gives predictable actions and is easier to test. The model only works inside a node (D12).
- **Why not let the model decide who to call?** A model mistake could double-book a technician or skip the escalation. Reserve, ring, retry and the manager alert are deterministic code behind tools (D19, D20).
- **What if two calls want the same technician?** The hold is atomic in TechnicianActor. Six parallel reserves gave one winner (V-014).
- **Why actors and KV?** Actors on the hot path for speed. KV is the slow durable copy, kept off the voice path (D13).
- **What stops it dialling the wrong person?** Flags default to `dry_run`, a `+61` allow-list, a per-technician cooldown and daily caps.
- **How would you know it broke?** Structured logs with a request id, actor logs, latency timers and `/admin/job-state`. No phone numbers are logged.
- **What did the tooling cost?** `dogfooding.md` covers the OpenCode issues, the scaffold failure and the account balance that blocked inference for a day.
