// scripts/chat-test.ts
// Runs every scenario in tests/chat/scenarios.json against the live assistant
// chat API, one at a time, and exits non-zero if any scenario fails.
// --only <scenario id> runs one scenario, --repeat <n> runs each selected
// scenario n times (a fresh conversation per run; all n must pass).
// The key comes only from TELNYX_API_KEY and is never printed.
// T1.5: if ADMIN_TOKEN is set, each caller scenario is preceded by a
// best-effort clearDispatch reset of tech-01..tech-03 against the deployed
// function (leftover holds/dispatches otherwise leak into the next booking
// scenario). The token is read like TELNYX_API_KEY and never printed.
// Exit codes: 0 all pass, 1 any FAIL/ERROR, 2 usage error or no API key,
// 3 the first conversation creation of the run failed (STOP rule).

import { readFile } from "node:fs/promises";
import {
  DEFAULT_ASSISTANT_ID,
  NO_CALL_REF_NOTE,
  aggregateRuns,
  callRefRejected,
  formatCallEvidence,
  parseCliArgs,
  parseScenarios,
  runScenario,
  type FetchLike,
  type RunnerConfig,
  type RunVerdict,
  type Scenario,
} from "./chat-test-lib.js";

function write(line: string): void {
  process.stdout.write(line + "\n");
}

const DEFAULT_FUNCTION_URL = "https://dispatch-b823b5bf-9.telnyxcompute.com";
const RESET_TECH_IDS = ["tech-01", "tech-02", "tech-03"];

// Best-effort clearDispatch for each RESET_TECH_IDS id; failures are ignored
// so a reset outage never stops the run. The token is only ever a header.
async function resetTechnicians(functionUrl: string, token: string): Promise<void> {
  for (const techId of RESET_TECH_IDS) {
    try {
      await fetch(`${functionUrl}/admin/tech`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ tech_id: techId, method: "clearDispatch" }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // ignore: a failed reset must not stop the scenario
    }
  }
}

async function loadScenarios(): Promise<Scenario[]> {
  const url = new URL("../tests/chat/scenarios.json", import.meta.url);
  return parseScenarios(JSON.parse(await readFile(url, "utf8")));
}

async function main(): Promise<number> {
  const scenarios = await loadScenarios();
  const opts = parseCliArgs(
    process.argv.slice(2),
    scenarios.map((s) => s.id),
  );
  if ("error" in opts) {
    write(opts.error);
    return 2;
  }
  const apiKey = process.env.TELNYX_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    write("TELNYX_API_KEY is not set");
    return 2;
  }
  const cfg: RunnerConfig = {
    apiKey,
    assistantId: process.env.TELNYX_ASSISTANT_ID ?? DEFAULT_ASSISTANT_ID,
  };
  const fetchFn = globalThis.fetch as unknown as FetchLike;
  const selected =
    opts.only === null
      ? scenarios
      : scenarios.filter((s) => s.id === opts.only);

  const adminToken = process.env.ADMIN_TOKEN;
  const resetEnabled = adminToken !== undefined && adminToken !== "";
  if (!resetEnabled && selected.some((s) => s.caller !== undefined)) {
    write("ADMIN_TOKEN is not set; technician reset skipped");
  }

  let pass = 0;
  let fail = 0;
  let error = 0;
  let skippedTools = 0;
  let stopRuleArmed = true; // fires only on the first conversation creation
  const summary: string[] = [];
  const allFlow = new Set<string>();
  const allTools = new Set<string>();

  for (const scenario of selected) {
    if (resetEnabled && scenario.caller !== undefined) {
      await resetTechnicians(
        process.env.DISPATCH_FUNCTION_URL ?? DEFAULT_FUNCTION_URL,
        adminToken as string,
      );
      write("technician reset: clearDispatch sent for tech-01, tech-02, tech-03");
    }
    const verdicts: RunVerdict[] = [];
    let scenarioSkipped = false;
    for (let k = 1; k <= opts.repeat; k++) {
      write(
        opts.repeat > 1
          ? `== ${scenario.id} (${k}/${opts.repeat}) ==`
          : `== ${scenario.id} ==`,
      );
      const r = await runScenario(fetchFn, cfg, scenario, write);
      if (stopRuleArmed) {
        stopRuleArmed = false;
        if (r.createFailed !== null) {
          write(
            `STOP: first conversation creation failed: status ${r.createFailed.status} body ${r.createFailed.body}`,
          );
          return 3;
        }
      }
      if (r.conversationId !== null) write(`conversation: ${r.conversationId}`);
      write(
        `tools called: ${r.toolCalls.length > 0 ? r.toolCalls.map((t) => t.name).join(", ") : "none"}`,
      );
      r.toolCalls.forEach((t, i) => write(formatCallEvidence(t, i)));
      if (callRefRejected(r.toolCalls)) write(NO_CALL_REF_NOTE);
      write(`flow nodes: ${r.flowNodeIds.length > 0 ? r.flowNodeIds.join(", ") : "none"}`);
      if (r.toolAssertionsSkipped) {
        scenarioSkipped = true;
        write("tool assertions: SKIPPED");
      }
      for (const f of r.failures) {
        write(
          f.assertion === "caller_script_unmatched"
            ? `FAILED ${f.assertion}: ${f.detail} (harness gap, not necessarily an assistant fault)`
            : `FAILED ${f.assertion}: ${f.detail}`,
        );
      }
      write(r.verdict);
      verdicts.push(r.verdict);
      for (const n of r.flowNodeIds) allFlow.add(n);
      for (const t of r.toolCalls) allTools.add(t.name);
    }
    const agg = aggregateRuns(verdicts);
    if (scenarioSkipped) skippedTools += 1;
    if (agg.verdict === "PASS") pass += 1;
    else if (agg.verdict === "FAIL") fail += 1;
    else error += 1;
    if (opts.repeat > 1) {
      write(`${scenario.id}: ${agg.passed}/${opts.repeat} passed -> ${agg.verdict}`);
    }
    summary.push(
      `${scenario.id}: ${agg.verdict} (${agg.passed}/${opts.repeat} passed)${scenarioSkipped ? " (tool assertions skipped)" : ""}`,
    );
  }

  write("--- summary ---");
  for (const line of summary) write(line);
  write(`total ${selected.length}: pass=${pass} fail=${fail} error=${error} tool-skips=${skippedTools}`);
  write(`flow_node_id values seen: ${allFlow.size > 0 ? [...allFlow].join(", ") : "none"}`);
  write(`tool names seen: ${allTools.size > 0 ? [...allTools].join(", ") : "none"}`);
  return fail + error === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    write(`fatal ${err instanceof Error ? err.message : "unknown"}`);
    process.exitCode = 1;
  },
);
