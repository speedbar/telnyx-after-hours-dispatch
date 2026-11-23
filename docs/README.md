# Docs index

## If you only have 15 minutes

1. `../README.md`: what it is, how to try it, how to know it broke.
2. `architecture.md`: one call from start to finish and where each part runs.
3. `bug-journal.md`: what broke, how it was found, and what was done.
4. `decisions.md`: why it is built this way (D1 onwards).
5. `demo-script.md`: what the demo shows.

Everything else is reference. It is there so you can check any claim.

| If you want to... | Read |
|---|---|
| Understand the system in 5 minutes | `architecture.md` |
| See what each actor and KV stores | `data-model.md` and `data-flow.svg` |
| See why it is built this way | `decisions.md` (numbered D1 onwards) and `use-case.md` |
| Follow the demo | `demo-script.md` |
| See what was tested and what broke | `test-matrix.md`, `bug-journal.md`, `edge-cases.md` |
| See what was checked against Telnyx's docs | `verify-log.md` |
| See how the tooling behaved | `dogfooding.md` |
| Reproduce the Portal configuration | `portal/` (nodes, edges, assistant text, paste sheets) |
| See how the code was produced with OpenCode | `tasks/` (one spec per slice) and `../AGENTS.md` |
