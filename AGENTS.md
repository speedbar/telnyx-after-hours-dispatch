# AGENTS.md: dispatch (after-hours urgent-call dispatch on Telnyx)

## What this is
A voice AI assistant for a trade business (plumber/electrician). After-hours calls are triaged, an on-call technician is reserved, and the caller is warm-transferred to them. Built for the Telnyx FDE take-home. A working simple solution beats an ambitious broken one.

## Hard rules
1. All code in this repo is written through OpenCode with a Telnyx-hosted model (telnyx/...). No other coding tool.
2. TypeScript, strict. Stateful Actors and the typed KV binding are TypeScript-only. Only exception: scripts/scrub-sdk-examples.mjs (plain Node, runs at postinstall).
3. Deploy on Telnyx Edge Compute. One umbrella function `dispatch` described by telnyx.toml. The human runs `telnyx-edge ship`. Never run ship, `secrets add`, or any command that changes the Telnyx account unless the task says so.
4. telnyx.toml: the [edge_compute] block (func_id, func_name) is written by the CLI. Never edit or remove it.
5. Handler shape: `export default { async fetch(request, env) }` plus `export { TechnicianActor }`. Never http.createServer. Actors are declared only in telnyx.toml, never func.toml.
6. Secrets: never read, print, log, write or commit one. Read config via env.X. .env is never committed; .env.example holds names only. If a task seems to need a secret value, stop and ask.
7. Dependencies: @telnyx/edge-runtime at runtime; typescript, @types/node and tsx for development. Nothing else unless the task says so.
8. Telnyx behaviour you are unsure of: say so, propose a one-line test, record the result in docs/verify-log.md. Do not invent CLI flags, config keys or API fields. Copy config syntax from a CLI scaffold or the docs, never from memory.

## Design
- Workflow-first: the call skeleton is a deterministic Conversation Workflow. An LLM is used only inside nodes (triage, detail extraction, technician briefing).
- Anything with consequences is deterministic code: reservation, retries, escalation, safety wording.
- Primitives: Actor = per-technician reservation state (read-modify-write). KV = flags, customers, jobs, idempotency (no transactions, no compare-and-swap: never build locks or counters on it). Plain function logic otherwise. Record the reason in docs/decisions.md.
- Business systems are mocked behind the MCP tools; the README says so.

## Conventions
- Logs: one JSON object per line, written only through src/lib/log.ts once it exists. No other console.log. Never log full phone numbers (hash them) or secrets.
- MCP tool results are plain JSON with an `ok` boolean. Business failures are returned as data, not thrown.
- Keep docs/bug-journal.md current: symptom, evidence, root cause, fix, signal that found it.

## Working agreement
- Each task has a spec in docs/tasks/. Read it, do exactly that and nothing else. Do not edit the spec, AGENTS.md, README.md or docs/ unless the spec says so.
- After the task run `npx tsc --noEmit` and the tests named in the spec, show the results, then stop. Do not start the next task.
- Same error twice: stop and report it.
- Never commit; the human commits.
- Do not modify .opencode/.

## Layout (target)
src/index.ts      router: /dv /mcp /events /health /ops; re-exports TechnicianActor
src/lib/          log.ts sig.ts kv.ts ids.ts
src/routes/       dv.ts mcp.ts events.ts ops.ts
src/tools/        lookup_customer.ts reserve_technician.ts create_job.ts release_technician.ts
src/actors/       TechnicianActor.ts
assistant/        assistant.json workflow.json prompts/
scripts/          scrub-sdk-examples.mjs simulate.ts seed.ts sign.ts apply-assistant.ts latency.ts
tests/            sig.test.ts mcp.test.ts actor.test.ts guards.test.ts
docs/             decisions.md bug-journal.md verify-log.md dogfooding.md test-matrix.md demo-script.md tasks/ evidence/
root              telnyx.toml package.json tsconfig.json .env.example

## Definition of done
- Calling the number reaches the assistant. An emergency call reserves a technician, rings them, briefs them, and bridges on acceptance.
- Decline or no answer: next technician, then a fallback message. No dead ends.
- Two simultaneous callers never get the same technician (proved by the concurrency script, no phone needed).
- With the MCP server stopped, the call ends gracefully and the failure shows in logs or metrics within a minute.
- README, architecture diagram, demo script, decisions, bug journal and the OpenCode config are in the repo.

## Platform facts learned the hard way
- KV keys may contain only a-z A-Z 0-9 - _ / = . (no colon, no plus, no space). Use "/" as the separator. Build every key through one helper in src/lib/ that validates against /^[A-Za-z0-9\-_\/=.]+$/.
- KV is slow from the edge function: about 1.5 to 1.9 s per operation (BUG-003). Actor storage is under 0.1 s. Never read or write KV on a voice turn, inside /dv or inside an MCP tool call. Hot state goes through actors; KV is written off the hot path. Every tool and route must answer in under 500 ms (the /dv webhook in under 300 ms).

## Git workflow
- Never run git commit, git push, git switch or git merge. The human does all git writes (see Working agreement). Work on whatever branch is checked out.

## Saving tokens (standing rules)
- If the same check (tsc, a test, the scrub) fails twice with the same error, STOP and report the error and what you tried. Do not try a third approach.
- Do not reread files you already read in this session. Read only the files the task spec lists, plus the file you are editing.
- Do not explore the repo, run package installs, or add dependencies unless the spec says so.
- Run the tests once at the end, not after every small edit. Show only the summary lines (pass/fail counts and any failure), not full output.
- Keep replies short. No restating the spec, no long explanations of what you did; list the files changed and the check results, then stop.
- Do not refactor, rename or "improve" anything outside the task.
- Comments: one short line per function at most. Prefer targeted edits over rewriting a whole file. Keep tests compact: one assertion group per case, no long fixture comments.
- If the spec contradicts itself or a "do not edit" rule, pick the simplest reading, note the choice in one line in your final summary, and move on. Do not deliberate at length.
- Act after reading: make your first edit within about five steps of starting. Do not write code, full plans or long deliberation in your reasoning; decide briefly and edit. (A long planning step once ended a run with no output; BUG-004.)
