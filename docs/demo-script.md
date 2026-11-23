# Demo script (8 to 10 minutes)

What the demo shows, in order, with timings. Everything shown is built and was run live. Mocked parts are named as they come up.

| # | Time | What happens | What to look at |
|---|---|---|---|
| 1 | 20 s | **The problem.** After hours, a trade business loses jobs to voicemail, and a missed emergency costs more than a false alarm. | `use-case.md` |
| 2 | 80 s | **The design.** The call path is fixed. The model talks and extracts, code decides. Walk the system diagram and the call sequence. | `architecture.md` |
| 3 | 3 min | **Live call, emergency, from a known caller.** Ring from the second phone, whose number was seeded as a customer. Say "my kitchen is flooding near the power points". The assistant already knows the address and name, so it confirms them instead of asking ("Is the problem at ...?", "Am I speaking with ...?"). It gives the safety line, reads back the callback number and reads out a job reference. The technician's phone rings, they press 1, and the details SMS arrives. | Phone, SMS |
| 4 | 2 min 30 s | **The evidence.** Portal conversation history for the call (transcript, tool calls, node per turn). The `dv_out` log line with `caller_known` true. The function logs and actor logs for the same call, and `/admin/job-state` for its ring and SMS status. Then KV: list the customer keys and read one (commands below). | `telnyx-edge logs dispatch`, `telnyx-edge actors logs TechnicianActor`, `/admin/job-state`, KV commands |
| 5 | 80 s | **Failure and escalation.** A second call where the technician presses 2, then the manager gets one SMS when the attempts run out. Say what the flags do (`off`, `dry_run`, `live`) and that only `+61` numbers can be dialled. | Phone, SMS, `portal/` |
| 6 | 50 s | **A human on request.** Ask for a person on a call and show the transfer, accepted by voice. | Portal conversation history |
| 7 | 20 s | **Next.** The golden set against the live assistant, a manual deploy button, a visible Escalate node, kill-switch and time-cap edges. | `architecture.md`, last section |

## KV, shown live

Seeding writes the customer records and flags to KV and to the actors. To show the write and then the read:

```
telnyx-edge storage kv key list ce309914-f9dc-49c6-9429-632418ecec27 --prefix cust/
telnyx-edge storage kv key get ce309914-f9dc-49c6-9429-632418ecec27 cust/<seeded number, digits only>
```

Do the seed (`POST /admin/seed`) on screen just before, so the audience sees the write, then the list and the get. Say plainly that the call path reads the same data from DirectoryActor, not KV, because KV took 1.5 to 1.9 s per read against a 1.5 s webhook timeout (D13).

## Mocked or not built

Technicians, customers and the roster are mock data. Safety wording is scripted and needs review by a licensed tradesperson. The transfer outcome appears in Portal conversation history, not in function logs.
