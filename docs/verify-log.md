# Verify log
One entry per Telnyx behaviour tested. Status: CONFIRMED (docs) | OBSERVED (we saw it) | FAILED | OPEN.

### V-001 Is Edge Compute enabled on this account? (T1)
Date: 17 Nov 2026. Test: shipped a hello-world TypeScript function. Result: live at https://hello-7213b47e-1.telnyxcompute.com, curl returned {"message":"Hello from Telnyx Edge Compute!"}. Status: OBSERVED.

### V-002 Are Stateful Actors enabled on this account? (T2)
Date: 17 Nov 2026. Test: scaffolded with `telnyx-edge new-func --actor --name=actortest`, shipped, repeated curl. Result: live at https://actortest-0d2fe03b-f.telnyxcompute.com; the counter returned 2, 3, 4, 5 on successive requests, so actor state persists. Status: OBSERVED.

Pending S0.1 evidence: output of `opencode auth list`, `telnyx-edge --help`, `telnyx-edge metrics --help`.
