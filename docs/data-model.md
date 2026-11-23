# Data model

What the system stores, where, and for how long. The diagram is [data-flow.svg](data-flow.svg).

No customer data is kept in the logs. Technician phone numbers are not stored in any actor or KV; they come from the `TECH_PHONES_JSON` secret.

## Where each piece of state lives

| Store | One instance per | Written by | Read on a live call? |
|---|---|---|---|
| DirectoryActor | the business (named `directory`) | `/admin/seed`, ring and SMS counters | Yes (`/dv`, ring start) |
| TechnicianActor | technician (`tech-01` to `tech-03`) | `reserve_technician`, accept, release, alarm | Yes |
| JobActor | call (named by its `call_ref`) | `reserve_technician`, `create_job`, `release_technician`, ring and SMS logic | Yes |
| KV `dispatch-kv` | the business | `/admin/seed` only | No (1.5 to 1.9 s per op, decision D13) |

## DirectoryActor

| Key | Value | Notes |
|---|---|---|
| `flag/ring_mode` | `off`, `dry_run` or `live` | Missing means `dry_run` |
| `flag/sms_mode` | `off`, `dry_run` or `live` | Missing means `dry_run` |
| `flag/dispatch_enabled` | `"true"` or `"false"` | The kill switch; `"false"` sends the call to Fallback |
| `cust/<digits>` | JSON text: `name`, `address`, optional `customer_id` | Key is the caller number without the plus |
| `count/<name>/<UTC day>` | number | Daily caps for rings and SMS (default 20 each) |

Methods: `lookup`, `flag`, `bumpCounter`, `seed`. Keys may only use A-Z a-z 0-9 - _ / = . (BUG-002).

## TechnicianActor

| Field | Meaning |
|---|---|
| `status` | `available`, `held`, `dispatched` or `off_shift` |
| `held_for` | `call_ref`, `job_id`, `expires_at`, `created_at`, `booked`. A hold lasts 90 s |
| `dispatched_for` | `call_ref`, `job_id`, `until`. Busy for 30 min after an accept (`DISPATCH_BUSY_S`, default 1800) |
| `last_ring_at` | 60 s cooldown between rings |
| `updated_at` | last change |

Methods: `reserve`, `release`, `status`, `markBooked`, `extendHold`, `dispatch`, `clearDispatch`, `setShift`, `alarm`. A hold that nobody uses lapses by itself.

Mock roster: tech-01 Jordan (plumbing, gas), tech-02 Casey (electrical, hvac), tech-03 Riley (plumbing, other). One technician per trade in the demo, so a second call of the same trade inside the busy window goes to the manager. `clearDispatch` frees a technician.

## JobActor

| Group | Fields |
|---|---|
| Identity | `call_ref`, `job_id`, `tech_id`, `state` (`reserved`, `briefed`, `released`) |
| Triage | `urgency`, `trade`, `suburb`, `summary`, `hazards`, `flags` |
| Caller | `customer_name`, `address`, `contact_phone`, `details` |
| Dispatch | `dispatch_state` (`ringing`, `dispatched`, `unassigned`), `release_reason` |
| Ring | `ring` (mode, status, attempt, tried, current, confirm call id, seen event ids, outcome log, candidates), plus `ring_at`, `ring_alarm_ran_at`, `ring_start_reason`, `ring_token`, callback diagnostics |
| Texts | `sms_status`, `sms_at`, `manager_sms_status`, `manager_sms_at` |
| Lifetime | `retention_at`, `created_at`, `updated_at` |

A job is deleted by an alarm after `JOB_RETENTION_DAYS` (default 7, range 1 to 90). This is the only place caller details are kept.

## Variables returned by `/dv` at call start

`call_ref`, `business_name`, `caller_known`, `customer_name`, `customer_address`, `dispatch_enabled`, `fallback_number_spoken`, `hold_ttl_s`. The call has a 2 s deadline; on failure safe defaults are returned.

## Logs

One JSON line per event. Callers and calls appear as salted hashes only. No names, numbers or addresses. Each tool call carries step timers.

## Known gaps

- KV is written by the seed only and is never read at runtime.
- There is no "remember this customer" write path yet (E-16).
- Langfuse traces and function logs are lined up by time and `call_ref`, not one shared ID.
