# dispatch: after-hours urgent-call assistant (Telnyx FDE ANZ take-home)

A voice assistant for a trade business (plumbing, electrical, gas). It answers after hours, works out whether the call is an emergency, collects the details, reserves an on-call technician and records a job. It runs on Telnyx: an AI Assistant with a Conversation Workflow, a custom MCP server and a dynamic-variables webhook on Edge Compute, with Stateful Actors and KV for state.

## Honest status (19 Nov 2026)

| Area | State |
|---|---|
| Edge function `dispatch` (TypeScript), live | Built and verified |
| `/dv` dynamic-variables webhook, Ed25519 signature check | Built and verified live (about 570 to 665 ms) |
| `/mcp` server with 4 tools, bearer auth | Built and verified live (V-015) |
| DirectoryActor, TechnicianActor (atomic hold with expiry), JobActor | Built and verified live (V-011, V-014) |
| KV (`DISPATCH_KV`) | Used for the seeded durable copy only; slow (1.5 to 1.9 s per op), kept off the voice path |
| Conversation Workflow, 7 nodes, speak node `Close` | Built in the Portal; three conversation tests run |
| S1.5 tool hardening (server identifies call and job, fail-closed fallback) | Written by OpenCode, in the working tree, **not yet reviewed, merged or shipped** |
| Dialable phone number | **Not done** (account balance and verification) |
| Warm transfer to a technician | **Not built** |
| Kill-switch and time-cap edges, golden set, CI | Planned |

Everything the caller hears about a technician is mocked. No technician is phoned in this build. See `docs/test-matrix.md` for what was actually run.

## Why this design

Workflow first. The path of a call is fixed (triage, details, reserve, job, close, hang up). The model is used only inside a node to talk and to pull structured details from speech. Reserving a technician, retries and the fallback are deterministic code behind MCP tools, so a model mistake cannot double-book a technician or skip the fallback. See `docs/architecture.md`, `docs/decisions.md` and `docs/use-case.md`.

## Architecture

![architecture](docs/architecture.svg)

Routes on `https://dispatch-b823b5bf-9.telnyxcompute.com`: `/health`, `/dv`, `/mcp`, `/admin/seed`, `/admin/tech`.

## MCP tools

| Tool | Purpose |
|---|---|
| `lookup_customer` | Find the caller by phone number in the directory |
| `reserve_technician` | Atomically hold an on-call technician (requires name, address, callback number) |
| `create_job` | Write the job record for this call |
| `release_technician` | Release a hold (declined, no answer, caller hung up, error) |

On failure every tool returns `next: "fallback"`, `retry: false` and the missing fields, so the workflow goes to the Fallback node and does not loop.

## Run and verify

```
npm install
npm run typecheck
npm test
telnyx-edge secrets add <NAME>   # see .env.example for the names, never commit values
telnyx-edge ship
curl https://dispatch-b823b5bf-9.telnyxcompute.com/health
```

Secrets are set with the Edge CLI and never stored in the repo. `/health` reports booleans only.

## How this was built

- All repo code was written with Telnyx Inference as the coding model (Kimi-K3) through OpenCode (`@telnyx/opencode`), from task specs in `docs/tasks/`.
- Planning, specs, review notes and these documents were drafted with Claude and reviewed and owned by the candidate.
- Findings about the platform and tools are in `docs/dogfooding.md`, `docs/bug-journal.md` and `docs/verify-log.md`.

## Limitations and known risks

- Technician contact, customer data and the on-call roster are mock data.
- Safety wording (water near electrics, gas smell) is scripted and must be reviewed by a licensed tradesperson before any real use.
- The Job node currently says a technician "has been asked to contact" the caller. That is not true until a real dispatch exists; the mock disclosure covers it, and the wording should change before any live use.
- The `_meta` field names Telnyx sends on tool calls are unverified (V-016). The server falls back to a safe generated reference.
- Telnyx account balance went negative and disabled inference on 18 Nov; this blocked further OpenCode work (see `docs/dogfooding.md`).
