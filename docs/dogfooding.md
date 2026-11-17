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
