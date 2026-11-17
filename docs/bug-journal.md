# Bug journal
Each entry: When / where, Symptom, Evidence, Hypotheses ruled out, Root cause, Fix, Signal that found it, What we would add to catch it faster.

### BUG-001 Server-side secret scanner rejects `telnyx-edge ship` (false positive in SDK example values)
When / where: 17 Nov 2026, `telnyx-edge ship` (CLI v0.5.18) of the Stateful Actor scaffold "actortest".
Symptom: HTTP 422 "upload contains what looks like a secret ... index.ts:55609 (generic-api-key)".
Evidence: CLI error with the bundle line number. Rebuilt the bundle locally with esbuild (--platform=node) and read the lines around 55609: an example `token_group_id: '182bd5e5-...'` UUID in the bundled `telnyx` SDK (node_modules/telnyx).
Hypotheses ruled out: a Tailscale `tskey-auth-...` example in the same SDK was also edited, but it was not the trigger.
Root cause: false positive of the server-side secret scanner on doc-comment example values in the `telnyx` SDK, which @telnyx/edge-runtime pulls into the bundle (about 2.6 MB; it also bundles @aws-sdk/client-s3).
Fix: replaced the example UUID with EXAMPLE across node_modules/telnyx, after which `ship` succeeded. `npm install` undoes the edit, so scripts/scrub-sdk-examples.mjs runs as a postinstall hook (`npm run check:scrub` verifies).
Signal that found it: the CLI error with a line number, plus a local reproduction of the bundle.
What we would add: run `npm run check:scrub` before every ship. Open: check whether this is fixed upstream.
