# Edges, tools and graph (canonical, cfg-5; edges and toggles unchanged since cfg-3)

Read live from the Portal on 19 Nov 2026 and again on 20 Nov 2026 (cfg-4 read-back). Every edge below matches live. Note: the model often does the whole call from one node, so these LLM edges are advisory; rules that must always hold live in the assistant text.

## Edges (7)

| # | From | To | Condition type | Condition text |
|---|---|---|---|---|
| E1 | Triage | Details | LLM | urgency and trade are known |
| E2 | Details | Reserve | LLM | name, address, problem and callback number are all confirmed |
| E3 | Reserve | Job | LLM | reserve_technician returned ok |
| E4 | Reserve | Fallback | LLM | reserve failed, no technician available, or a tool error |
| E5 | Job | Fallback | LLM | create_job failed |
| E6 | Fallback | Close | LLM | the caller has been told what happens next |
| E7 | Close | Hang Up | Default (fallback) | none |

There is deliberately no Job to Close edge. Job ends the call itself (reference, logged line, goodbye, hangup).

Platform notes (from the Portal): edges from one node are evaluated top to bottom and the first match wins; a Default edge is always considered last.

## Graph and loop check

- Directed acyclic graph: no edge points back to an earlier node, no node points to itself. A call cannot loop between nodes.
- Success path: Triage, Details, Reserve, Job, then the call ends from Job by the `hangup` tool.
- Failure path: Reserve or Job, Fallback, Close, Hang Up.
- Every node can reach a call end. Close and Hang Up are reachable only through Fallback.
- Observed behaviour: LLM edges fire only if the model calls the transition tool. With GLM-5.3-Flash the model often does not, and does the whole call from Triage or Details. That cannot cause a loop (there is no back edge) but it means the assistant instructions must define the full sequence. They do (assistant.md, "Order of the call").

## Tool toggles per node (verified live)

| Node | Override assistant tools | Hang Up | Tools added on the node |
|---|---|---|---|
| Triage | ON | ON | none |
| Details | ON | ON | none |
| Reserve | OFF (inherits) | ON (inherited) | none |
| Job | OFF (inherits) | ON (inherited) | none |
| Fallback | OFF (inherits) | ON (inherited) | none |
| Close | n/a (speak) | n/a | n/a |
| Hang Up | n/a (tool node) | n/a | n/a |

Rule: Hang Up stays ON everywhere. With it off, calls did not end (BUG logged). MCP tools are not listed per node and stay callable from any node (a `reserve_technician` call ran with `flow_node_id` triage). Do not rely on node scoping for safety; the server validates everything.

## MCP server (verified live)

`dispatch-mcp`, allowed tools: `reserve_technician`, `create_job`, `release_technician`. `lookup_customer` is unticked: caller identification happens in `/dv` before the model speaks. The tool stays in the repo and tests.
