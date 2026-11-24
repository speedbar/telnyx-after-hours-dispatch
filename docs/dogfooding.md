# Dogfooding notes (Telnyx Inference via OpenCode, Edge CLI, Portal)
Date-stamped: what worked, what did not, workaround.

- 17 Nov 2026: OpenCode 2.3.0 does not work with @telnyx/opencode ("Unknown subcommand", "Unrecognized flag --provider", "Integration not found: telnyx"). OpenCode 2 changed its plugin API; the Telnyx docs still show V1 commands. Pinned OpenCode 1.19.6 (installer https://opencode.ai/install, not /v2/install). If V1 then fails with "Database is not empty and has no session table", move V2's ~/.local/share/opencode aside.
- 17 Nov 2026: `telnyx-edge new-func -l typescript` (from the challenge brief) fails on CLI v0.5.18. Use `--language ts --name <name>`. `ship` needs a package-lock.json.
- 17 Nov 2026: `telnyx-edge` OAuth token lasts about 30 minutes; re-run `telnyx-edge auth login`.
- 17 Nov 2026: `telnyx-edge new-func --actor --name=dispatch` prints a function ID immediately and writes it to telnyx.toml under [edge_compute] (func_id, func_name).
- 17 Nov 2026: the default actor scaffold fails to ship until the SDK example values are scrubbed (BUG-001).
- Per the models page: Kimi-K3 is not available for assistants; it works as the OpenCode coding model.
- 17 Nov 2026: `telnyx-edge storage kv create` reported a client-side timeout, but the namespace was created (see V-003). The CLI gives no hint that the request may have succeeded; run `telnyx-edge storage kv list` before retrying.
- 17 Nov 2026: the KV key character rule (a-z A-Z 0-9 - _ / = . only) is not stated where we looked (storage KV doc); we found it from an HTTP 400 on a deployed function. A one-line rule in the KV doc would have saved a design change.
- 17 Nov 2026: `telnyx-edge deployments`, `rollback`, `revisions`, `inspect` and `log-export` exist in v0.5.18 but our docs notes did not mention them. Worth trying `telnyx-edge deployments dispatch` the next time a ship fails.
- 18 Nov 2026: MCP tools are assistant-level in the Portal, not per workflow node. Prompts cannot scope them; the server must enforce order.
- 18 Nov 2026: the dynamic-variables webhook URL and timeout can only be set through the API (PATCH /v2/ai/assistants/{id}), not in the Portal.
- 18 Nov 2026: the Portal Test assistant is a web call; the caller "number" is a SIP address, so use a typed callback number in tests.
- 18 Nov 2026: a negative balance (-$0.43) disabled the account and blocked inference. OpenCode showed error 10039 (monthly inference limit), then 20015 "Feature not enabled: User account is not enabled for inference". The public error pages describe these only generically.
- 23 Nov 2026: `telnyx-edge secrets add TECH_PHONES_JSON --value ...` fails with "unknown flag". The form that works is `telnyx-edge secrets add <key> <value>`.
- 23 Nov 2026: a GitHub Actions deploy needs `npm ci` before `telnyx-edge ship`, otherwise the build cannot resolve `@telnyx/edge-runtime`. Right after a successful ship the `/health` URL answered 404 for a short while; a health check with retries fixed it. The CLI is pinned to v0.5.18 in the workflow.
- 23 Nov 2026: the Portal's Langfuse integration shows every assistant turn, tool call, token count, timing and workflow node. Nothing joins a trace to the function logs by one ID, so the two are lined up by time and `call_ref`.
