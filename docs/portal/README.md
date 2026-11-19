# Portal configuration: source of truth

Everything the Telnyx Portal holds for `dispatch-ai` that is not code lives here: assistant instructions, every node's text, every edge, every tool toggle. If it is not in this folder, it is not decided.

Last read live from the Portal: 20 Nov 2026 (read-only, nothing changed by the read). Live is cfg-4 and matched this folder's cfg-4 text, apart from list-number rendering (VERIFY whether the stored text includes "1." to "5.").
Config version this folder describes: **cfg-5, pending paste**. The cfg-5 edits are the assistant Instructions block, the Job node and the Fallback node (`consistency.md` section 5). Edge cases and what is and is not handled: `docs/edge-cases.md`.

## Files

| File | Holds |
|---|---|
| `assistant.md` | Model, greeting, assistant-level instructions, dynamic variables, MCP allowed tools |
| `nodes.md` | Each workflow node: type, instructions, mode, LLM, tool toggles |
| `edges.md` | Every edge, its condition, evaluation notes, the graph and its paths |
| `consistency.md` | Prompt vs tool schema vs code vs `/dv` matrix, loop check, findings, pending changes, change log |

## Rules (so one change never breaks another)

1. **Repo first.** Change the text in this folder, commit, then paste into the Portal. Never the other way round.
2. **Whole blocks only.** Paste a whole node or the whole assistant instruction, never a single changed sentence. This avoids half-updated places.
3. **One fact, one owner.** A rule lives in one place unless it must be repeated for safety. Repeats are listed in `consistency.md` section 3 so they are changed together.
4. **Use the tool's own words.** Nodes name tool fields and values exactly as the schema does (`contact_phone`, `emergency`, `urgent`). The schema is in `src/tools/index.ts`.
5. **Positive wording.** Say what to do, not what not to call. Forbidding a tool can block the edge transition (platform gotcha, seen in tests).
6. **After every Portal save, read it back** and diff against this folder. The checklist is in `consistency.md` section 6. Update the "last read live" line above.
7. **No secrets, no real numbers, no real addresses** in this folder. The webhook URL and the fallback number are not recorded here.
8. **Every change gets a line in the change log** with the test call that showed the need.

## Status of live vs this folder

| Place | Live (cfg-4) equals folder (cfg-5)? | Action |
|---|---|---|
| Assistant instructions | No: step 6 failure rule, reserve guard, one-goodbye rule, number guard (cfg-5) | Paste whole block from `assistant.md` |
| Triage | Yes | None |
| Details | Yes | None |
| Reserve | Yes | None |
| Job | No: "only if reserve_technician returned ok" (cfg-5) | Paste whole node |
| Fallback | No: new wording (cfg-5) | Paste whole node, then run the failure drill (P3) |
| Close, Hang Up | Yes | None |
| Edges (7) | Yes | None |
| Tool toggles | Yes | None |
| MCP allowed tools | Yes: `lookup_customer` already unticked | None |

Pending, not yet applied: P1 (caller record variables, needs a real-number call to test), P2 (invalid callback retry, ships with S1.8), P3 (Fallback, Close, Hang Up by voice, after cfg-5 and the failure drill), P4 to P6 (delayed-response line, voice tags, model stalls). See `consistency.md` section 4.
