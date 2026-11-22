# After-hours urgent-call dispatch

When a pipe bursts at 2 am, the customer rings a trade business and gets voicemail. This project answers that call instead. A voice assistant picks up, works out whether it's an emergency, takes the address and the problem, books an on-call technician, rings them, and texts them the details. If nobody accepts, the manager gets a text.

It runs on Telnyx: a voice AI assistant with a workflow, a small TypeScript service on Telnyx Edge Compute, and a phone number.

## Try it

- Phone number: in the email I sent with this repo.
- Health check: https://dispatch-b823b5bf-9.telnyxcompute.com/health
- Things to say: "my kitchen tap burst" for the urgent path, "there's a gas smell" for the safety line, "can I talk to a person" for the human transfer.

**What ringing means for you.** The assistant takes the job on any call, and ringing and texting are live. The technician ring and the texts go to the numbers set in my deployment, which are my own test phones, and you can't change them from outside. So a test call will ring my phone, and if I don't pick up the assistant tries the next technician and then texts the manager. Ring and text volume is capped per day. If you'd rather feel the ring on your own mobile, send me the number and I'll add it as a technician. Or run your own copy, below.

## How it works

![Architecture overview](docs/architecture-overview.svg)

The conversation follows a fixed path: triage, details, reserve a technician, log the job, close. If a tool fails, the call drops into a fallback that gives the caller the office number. The model's job is to talk and pull out details at each step. It doesn't decide who gets booked or whether anyone gets rung.

That part is ordinary code, called by the assistant as tools. I did it this way because a wrong guess here costs a real call-out, or a missed emergency. Code can't double-book a technician, skip a retry, or forget to alert the manager. A model can.

Some other choices worth knowing about:

- **Known callers.** When a call starts, the assistant asks my service who's ringing. If the number is in the customer list it says "Is the problem at 1 Smith St?" and "Am I speaking with Sam?" instead of asking everything from scratch.
- **Safety switches.** Ringing and texting each have an off, dry-run and live mode, so I can test without waking anyone. Only Australian (+61) numbers can be dialled, and each technician has a cooldown and a daily cap.
- **State.** Technician holds, job records and the customer list live in Telnyx Stateful Actors, which give atomic updates. KV stores a durable copy when data is seeded, but the call path doesn't read it. Reads took 1.5 to 1.9 s each, and the webhook gives up at 1.5 s (`docs/decisions.md`, D13).

## When something goes wrong

| What happens | What the caller or team gets |
|---|---|
| Danger (gas smell, water near power) | Told to call triple zero. |
| Technician free | They're rung and press 1 to accept or 2 to decline. On accept they get the job by text. |
| Technician declines or doesn't answer | The next technician is tried, two attempts in all. |
| Nobody accepts | The manager gets a text and the job stays logged. |
| A tool fails or takes over 5 s | The caller is given the office number and told to ring triple zero if in danger. |
| Caller asks for a person | The call is transferred to a human, who accepts by voice. If nobody does, the assistant keeps logging the job. |

## Run it yourself

You don't need to, the live number is the demo. But you can build and test the code on your own machine. You need Node 18 or newer.

```
npm ci
npm run typecheck
env -u MCP_TOKEN -u TELNYX_API_KEY -u ADMIN_TOKEN npm test
```

The tests need no Telnyx account. The `env -u` part stops tokens in your shell from changing the auth tests. Dependencies are in `package.json` and the lockfile, so there's no `requirements.txt`; this is a Node project.

To deploy your own copy you need a Telnyx account and the `telnyx-edge` CLI:

1. Log in with `telnyx-edge auth login`.
2. `telnyx.toml` holds my function id. Create your own function and put its id and name under `[edge_compute]`. I haven't tried this from a clean account.
3. Settings. `.env.example` lists every name with a comment. Put `TELNYX_API_KEY` in your shell and add the rest with `telnyx-edge secrets add <NAME>`. Never commit values. The ones that decide who gets contacted:
   - `TECH_PHONES_JSON`: technician ids and their phones, for example `{"tech-01":"+61400000000"}`. Put your own mobile here to feel the ring.
   - `MANAGER_PHONE`: gets the "nobody accepted" text. Digits with the country code, like `61400000000`, no plus sign.
   - `FALLBACK_NUMBER`: the office number the assistant reads out when something fails.
   - `ALLOWED_DIAL_PREFIXES`: rings and texts only go to `+61` unless you add other prefixes here, comma separated. Add yours if you're testing from another country.
4. `telnyx-edge ship`, then open `/health` and check that nothing says `false`.
5. Load customers and switch ringing on with `POST /admin/seed` (admin token). Until you do, ringing and texting stay in dry-run. This seeds one known caller and turns both on:
   ```
   {"customers":[{"phone":"+61400000000","record":{"name":"Sam","address":"1 Smith St, Sydney"}}],
    "flags":{"ring_mode":"live","sms_mode":"live"}}
   ```
   Call from that number and the assistant greets you by name and address. A caller who isn't in the list is asked for everything. Use `"dry_run"` instead of `"live"` to test without ringing anyone.
6. The assistant, workflow, MCP server and phone number are set up by hand in the Portal. The exact text is in `docs/portal/`.

## Seeing what's happening

Every log line is one JSON object, written in one place (`src/lib/log.ts`). Phone numbers are never logged, only a salted hash, and every tool call records how long each step took.

```
telnyx-edge logs dispatch --since 30m --last 250
telnyx-edge actors logs TechnicianActor --since 60m
telnyx-edge metrics dispatch --errors
```

`GET /admin/job-state` (admin token) shows a call's ring and SMS status.

### If it breaks, how I'd know within a minute

Nothing pages me yet, so the check is a test call, then these in order:

1. `curl` the `/health` URL. A `false` means a missing secret or binding.
2. `telnyx-edge metrics dispatch --errors` for the error rate and latency.
3. `telnyx-edge logs dispatch --since 5m --last 250`. Look for `"level":"error"`, then follow one call by its `call_ref`.
4. `/admin/job-state` and the TechnicianActor logs, to see whether a ring or text was attempted.
5. The last call in Portal conversation history, to see which node it was in and which tool it called.

### Two bugs and how I found them

**The manager text was silently not sent (BUG-024, worked around).** The job state showed the manager SMS as `skipped`. Filtering the logs on SMS events showed an error called `prefix`. A `+61` number was being turned into `++61`, which failed the allow-list. My tests missed it because they only used numbers written as digits. For now the number is stored as digits with the country code, which avoids it. The proper fix is one line plus a test for every phone format, and it's still to do.

**Two calls fell back to the office number (BUG-027, cause still open).** The transcript showed a 5 s `tool_timeout` on `reserve_technician`. The log line for that call showed where the time went: 14,143 ms and 10,833 ms on reading a brand-new job record, while every other step was normal. A call 15 minutes later was fast again. I haven't found the cause, and the timers are how I caught it.

Both are written up in `docs/bug-journal.md` with the other bugs.

## How it was built

All the code was written with Telnyx Inference (Kimi-K3) through OpenCode (`@telnyx/opencode`). Each piece of work has a task file in `docs/tasks/`, and `AGENTS.md` holds the standing rules. The OpenCode config is `.opencode/opencode.json`. I used Claude to help plan and review, and I own the specs and the decisions.

## Limits and what I'd do next

- Technicians, customers and the business name are made up.
- The safety wording (gas, water near electrics) is scripted. A licensed tradesperson should check it before real use.
- It only works for Australia. Rings and texts go to +61 numbers only, and the spoken lines assume triple zero. New Zealand isn't covered.
- Speed is the weak spot. Any tool call over 5 s sends the caller to the fallback, and a slow first read happened once. Next I'd time-limit that read, start the technician reserve alongside it, and alert when a tool call passes 4 s.
- New callers are not remembered. The customer list is loaded by hand, so a first-time caller is asked everything again on the next call. Saving them after a job is the next step.
- Speech recognition can mishear, so the assistant reads back the address, name and number.
- I couldn't find a published limit on simultaneous inbound calls. Outbound calls have a low limit on a new account.

## More

| For | Read |
|---|---|
| One call from start to finish, and where each part runs | `docs/architecture.md` |
| Why things are built this way | `docs/decisions.md` |
| What was tested, and what broke | `docs/test-matrix.md`, `docs/bug-journal.md` |
| What was checked against Telnyx's docs | `docs/verify-log.md` |
| The exact Portal setup | `docs/portal/` |
| The demo run sheet | `docs/demo-script.md` |
