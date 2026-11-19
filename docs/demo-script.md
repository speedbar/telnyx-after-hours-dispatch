# Demo script (8 to 10 minutes)

Only show what is built. Say plainly what is mocked.

1. **Frame (30 s).** After-hours trade calls: a missed emergency is costly, a false alarm wastes a callout. The assistant triages, takes details, reserves a technician and records a job.
2. **Architecture (90 s).** Show `docs/architecture.svg`. Workflow first: the path is fixed, the model only talks and extracts, code does the reserve.
3. **Live call (3 min).** Portal Test assistant. Say: "my kitchen is flooding near the power points". Show the safety line, the details capture, a typed callback number, the closing line with the job reference.
4. **Show the evidence (2 min).** Conversation History (flow_node_id per turn, tool calls), then `telnyx-edge` logs by `request_id`.
5. **Failure path (90 s).** Show the fallback. Only run it live if the forced-fallback test has passed; otherwise show the design and say it is not yet tested.
6. **What I would do next (60 s).** Real number, warm transfer, kill switch, golden set in CI.

Be ready to say: technician data and contact are mocked; no technician is phoned; the dialable number is not done; the account balance blocked OpenCode for a day.

## Likely questions

- Why a workflow and not one prompt? Deterministic path, predictable actions, easier to test.
- Why not a vector store? Dispatch is exact lookups and state (D12).
- Why KV and actors? Actors for the hot path (fast), KV for durable copy (slow, D13).
- What if two calls want the same technician? Atomic hold in TechnicianActor; 6 parallel reserves gave one winner (V-014).
- What did the tooling cost or cost you? Dogfooding notes: OpenCode 2 incompatibility, scaffold failure, negative balance disabling inference.
