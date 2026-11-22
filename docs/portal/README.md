# Portal configuration: source of truth

Everything the Telnyx Portal holds for `dispatch-ai` that is not code lives here: assistant instructions, every node's text, every edge, every tool toggle. If it is not in this folder, it is not decided.

Last read live from the Portal: 20 Nov 2026 (read-only, nothing changed by the read). That read was cfg-4. Nabeel pasted cfg-5 afterwards and reports it live; no read-back diff of cfg-5 is recorded here (do one after the next paste). List-number rendering of the stored text is still VERIFY.
**Current live configuration (22 Nov 2026): cfg-9.** `cfg-8-paste-sheet.md` holds the live assistant Instructions block (emergency-services wording, name rule) and the live Details node text. `cfg-9-paste-sheet.md` adds the human-transfer tool settings and the "Human request" paragraph. Where those sheets differ from `assistant.md` and `nodes.md`, the paste sheets win; those two files and `edges.md` are the cfg-6 baseline. `cfg-5`, `cfg-6` and `cfg-7` are superseded.

Config version the baseline files describe: **cfg-6, live since 20 Nov 2026** (pasted and promoted to main by Nabeel; E4 reworded). The cfg-6 edits are the assistant Instructions block and the Details, Reserve, Job and Fallback nodes (`consistency.md` section 5). Edge cases and what is and is not handled: `docs/edge-cases.md`.

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

| Place | Live (cfg-6) equals folder (cfg-6)? | Evidence |
|---|---|---|
| Assistant instructions | Yes | Read back by Nabeel 20 Nov; compared by script, identical ignoring blank lines |
| Details, Reserve, Job, Fallback | Yes | Read back by Nabeel 20 Nov; compared by eye |
| Triage, Close, Hang Up | Yes | Read from the Portal 20 Nov (Triage text and toggles; Close and Hang Up nodes present) |
| Edges (7) | Yes; E4 reworded and exact | Read from the Portal 20 Nov; E1, E2, E3, E5, E6 seen as truncated labels only |
| Tool toggles, MCP allowed tools | Yes | Read from the Portal 20 Nov: Triage and Details override ON with Hang Up only; Reserve, Job, Fallback inherit; MCP allowed tools the three listed; filler-message row present (content and delay not read) |

Next: the chat golden set and voice calls (`consistency.md` section 5).

Pending, not yet applied: P1 (caller record variables, needs a real-number call to test), P3 (Fallback, Close, Hang Up by voice, failure drill), P4 to P6 (delayed-response line, voice tags, model stalls), P7 (closing line B after the technician ring), P8 (text the caller their job ID, stretch). P2 (invalid callback retry) is applied in cfg-6. See `consistency.md` section 4.
