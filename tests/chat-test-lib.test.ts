// tests/chat-test-lib.test.ts
// Unit tests for the chat harness helpers. All fetch calls are injected
// fakes: no network. The fake API key proves the key stays out of URLs,
// bodies and any printed line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createConversationRequest,
  chatRequest,
  messagesRequest,
  extractConversationId,
  extractAssistantContent,
  extractMessages,
  parseScenarios,
  parseCliArgs,
  aggregateRuns,
  evaluateAssertions,
  truncate,
  runScenario,
  tokenMatch,
  formatCallEvidence,
  callRefRejected,
  NO_CALL_REF_NOTE,
  extractQuestion,
  pickCallerRoute,
  routeSay,
  type CallerRoute,
  type CallerScript,
  type FetchLike,
  type FetchInit,
  type RunnerConfig,
  type Scenario,
  type ToolCallRecord,
  type ToolResultInfo,
} from "../scripts/chat-test-lib.js";

const KEY = "TEST-KEY-not-a-secret";
const cfg: RunnerConfig = {
  apiKey: KEY,
  assistantId: "assistant-test",
  timeoutMs: 5,
};

test("request builders: endpoints, bodies and auth; key never in url or body", () => {
  const c = createConversationRequest(cfg, "E-01");
  assert.equal(c.url, "https://api.telnyx.com/v2/ai/conversations");
  assert.equal(c.init.method, "POST");
  assert.deepEqual(JSON.parse(c.init.body as string), {
    name: "chat-test E-01",
    metadata: {
      assistant_id: "assistant-test",
      telnyx_conversation_channel: "web_chat",
    },
  });
  const t = chatRequest(cfg, "cid-1", "hello");
  assert.equal(t.url, "https://api.telnyx.com/v2/ai/assistants/assistant-test/chat");
  assert.deepEqual(JSON.parse(t.init.body as string), {
    content: "hello",
    conversation_id: "cid-1",
  });
  const m = messagesRequest(cfg, "cid-1");
  assert.equal(m.url, "https://api.telnyx.com/v2/ai/conversations/cid-1/messages");
  assert.equal(m.init.method, "GET");
  for (const req of [c, t, m]) {
    assert.ok(!req.url.includes(KEY), "key in url");
    assert.ok(!(req.init.body ?? "").includes(KEY), "key in body");
    assert.equal(req.init.headers.authorization, `Bearer ${KEY}`);
  }
});

test("response extractors: conversation id and assistant content shapes", () => {
  assert.equal(extractConversationId({ id: "a" }), "a");
  assert.equal(extractConversationId({ data: { id: "b" } }), "b");
  assert.equal(extractConversationId({ data: {} }), null);
  assert.equal(extractConversationId("nope"), null);
  assert.equal(extractAssistantContent({ content: "hi" }), "hi");
  assert.equal(extractAssistantContent({ data: { content: "hi" } }), "hi");
  assert.equal(extractAssistantContent({ message: { content: "hi" } }), "hi");
  assert.equal(
    extractAssistantContent({ choices: [{ message: { content: "hi" } }] }),
    "hi",
  );
  assert.equal(extractAssistantContent({ nope: 1 }), null);
});

test("extractMessages: tool calls (wrapped and flat), flow nodes, bad shape", () => {
  const got = extractMessages({
    data: [
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "reserve_technician",
              arguments: '{"urgency":"emergency"}',
            },
          },
          { name: "create_job", arguments: { address: "11 King Street" } },
        ],
        metadata: { flow_node_id: "reserve" },
      },
      { role: "assistant", flow_node_id: "job" },
      { role: "assistant", metadata: { flow_node_id: "job" } },
      "junk",
    ],
  });
  assert.ok(got !== null);
  assert.deepEqual(got.toolCalls, [
    { name: "reserve_technician", args: { urgency: "emergency" } },
    { name: "create_job", args: { address: "11 King Street" } },
  ]);
  // Newest-first input is reversed, so the "job" node comes before "reserve".
  assert.deepEqual(got.flowNodeIds, ["job", "reserve"]);
  assert.equal(extractMessages({ nope: [] }), null);
  assert.deepEqual(extractMessages([]), {
    toolCalls: [],
    flowNodeIds: [],
    assistantTexts: [],
  });
});

test("parseScenarios: good doc passes, junk throws, golden_id required", () => {
  const scenarios = parseScenarios({
    scenarios: [{ id: "x", golden_id: "C-01", turns: ["hi"], assertions: {} }],
  });
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].id, "x");
  assert.equal(scenarios[0].golden_id, "C-01");
  assert.throws(() => parseScenarios({}));
  assert.throws(() => parseScenarios({ scenarios: [{ id: 1 }] }));
  // golden_id must be present (null allowed) on every scenario
  assert.throws(() =>
    parseScenarios({ scenarios: [{ id: "x", turns: [], assertions: {} }] }),
  );
  const nullId = parseScenarios({
    scenarios: [{ id: "x", golden_id: null, turns: [], assertions: {} }],
  });
  assert.equal(nullId[0].golden_id, null);
  assert.throws(() =>
    parseScenarios({
      scenarios: [{ id: "x", golden_id: 5, turns: [], assertions: {} }],
    }),
  );
});

test("evaluateAssertions: reply assertions are case-insensitive", () => {
  const s = (assertions: Scenario["assertions"]): Scenario => ({
    id: "t",
    turns: [],
    assertions,
  });
  const base = { replies: ["Please call during Business Hours"], toolCalls: [], flowNodeIds: [] };
  assert.equal(
    evaluateAssertions(s({ reply_contains: ["business hours"] }), base).failures.length,
    0,
  );
  assert.equal(
    evaluateAssertions(s({ reply_contains: ["missing"] }), base).failures[0].assertion,
    "reply_contains",
  );
  assert.equal(
    evaluateAssertions(s({ reply_not_contains: ["BUSINESS hours"] }), base).failures[0].assertion,
    "reply_not_contains",
  );
  assert.equal(
    evaluateAssertions(s({ max_assistant_turns: 1 }), { ...base, replies: ["a", "b"] })
      .failures[0].assertion,
    "max_assistant_turns",
  );
});

test("evaluateAssertions: tools_called_exactly is a multiset, order ignored", () => {
  const s: Scenario = {
    id: "t",
    turns: [],
    assertions: { tools_called_exactly: ["b", "a", "a"] },
  };
  const run = (names: string[]) => ({
    replies: [],
    toolCalls: names.map((name) => ({ name, args: {} })) as ToolCallRecord[],
    flowNodeIds: [],
  });
  assert.equal(evaluateAssertions(s, run(["a", "b", "a"])).failures.length, 0);
  assert.equal(evaluateAssertions(s, run(["a", "b"])).failures.length, 1); // duplicate counted
  const none: Scenario = { id: "t", turns: [], assertions: { tools_called_exactly: [] } };
  assert.equal(evaluateAssertions(none, run([])).failures.length, 0);
  assert.equal(evaluateAssertions(none, run(["x"])).failures.length, 1);
});

test("evaluateAssertions: tool args match any-of, case-insensitive, token-bounded", () => {
  const input = {
    replies: [],
    toolCalls: [
      { name: "create_job", args: { address: "Eleven King Street, Wollongong" } },
    ] as ToolCallRecord[],
    flowNodeIds: [],
  };
  const s = (assertions: Scenario["assertions"]): Scenario => ({
    id: "t",
    turns: [],
    assertions,
  });
  assert.equal(
    evaluateAssertions(
      s({
        tool_arg_contains: [
          { tool: "create_job", field: "address", value: ["Eleven", "11"] },
        ],
      }),
      input,
    ).failures.length,
    0,
  );
  // The correction case: "Eleven King Street" must not trip "Leven King".
  assert.equal(
    evaluateAssertions(
      s({
        tool_arg_not_contains: [
          { tool: "create_job", field: "address", value: "Leven King" },
        ],
      }),
      input,
    ).failures.length,
    0,
  );
  assert.equal(
    evaluateAssertions(
      s({
        tool_arg_not_contains: [
          { tool: "create_job", field: "address", value: "Eleven King" },
        ],
      }),
      input,
    ).failures.length,
    1,
  );
  assert.equal(
    evaluateAssertions(
      s({
        tool_arg_contains: [
          { tool: "create_job", field: "address", value: "ELEVEN KING" },
        ],
      }),
      input,
    ).failures.length,
    0,
  );
  assert.equal(
    evaluateAssertions(
      s({
        tool_arg_contains: [{ tool: "create_job", field: "address", value: "12" }],
      }),
      input,
    ).failures[0].assertion,
    "tool_arg_contains",
  );
  // Tool never called at all.
  assert.equal(
    evaluateAssertions(
      s({
        tool_arg_contains: [{ tool: "reserve_technician", field: "urgency", value: "emergency" }],
      }),
      input,
    ).failures[0].detail,
    "reserve_technician not called",
  );
});

test("evaluateAssertions: null toolCalls skips tool assertions, replies still judged", () => {
  const s: Scenario = {
    id: "t",
    turns: [],
    assertions: {
      reply_contains: ["hello"],
      tools_called_exactly: [],
      tool_arg_contains: [{ tool: "x", field: "y", value: "z" }],
    },
  };
  const ev = evaluateAssertions(s, { replies: ["hello"], toolCalls: null, flowNodeIds: [] });
  assert.equal(ev.failures.length, 0);
  assert.equal(ev.skipped.length, 2);
  const bad = evaluateAssertions(s, { replies: ["bye"], toolCalls: null, flowNodeIds: [] });
  assert.equal(bad.failures.length, 1);
});

test("tokenMatch: case-insensitive with token boundaries", () => {
  assert.equal(tokenMatch("Gas smell reported.", "gas"), true);
  assert.equal(tokenMatch("11 King Street", "11"), true);
  assert.equal(tokenMatch("111 King Street", "11"), false);
  assert.equal(tokenMatch("0400 123 456", "0400"), true);
  assert.equal(tokenMatch("Eleven King Street", "Leven King"), false);
  assert.equal(tokenMatch("Leven King Street", "Leven King"), true);
});

test("extractMessages: reverses newest-first, pairs results, active_flow_node_id", () => {
  const got = extractMessages({
    data: [
      {
        role: "assistant",
        content: "Sorry, something went wrong.",
        metadata: { active_flow_node_id: "close" },
      },
      {
        role: "tool",
        tool_call_id: "call-2",
        text: '[{"ok":false,"reason":"invalid_input","next":"fallback","bad_fields":["call_ref"]}]',
      },
      {
        role: "assistant",
        tool_calls: [
          { id: "call-2", function: { name: "create_job", arguments: '{"address":"11 King Street"}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        text: '{"ok":false,"reason":"invalid_input","bad_fields":["call_ref"]}',
      },
      {
        role: "assistant",
        content: "Is that number correct?",
        tool_calls: [
          { id: "call-1", function: { name: "reserve_technician", arguments: { urgency: "emergency" } } },
        ],
      },
    ],
  });
  assert.ok(got !== null);
  // Chronological order and pairing by tool_call_id (array-shaped payload too).
  assert.deepEqual(
    got.toolCalls.map((c) => c.name),
    ["reserve_technician", "create_job"],
  );
  assert.equal(got.toolCalls[0].text, "Is that number correct?");
  assert.deepEqual(got.toolCalls[0].result, {
    ok: false,
    reason: "invalid_input",
    next: null,
    bad_fields: ["call_ref"],
    raw: '{"ok":false,"reason":"invalid_input","bad_fields":["call_ref"]}',
  });
  assert.equal(got.toolCalls[1].result?.ok, false);
  assert.equal(got.toolCalls[1].result?.next, "fallback"); // from the array-shaped payload
  assert.deepEqual(got.toolCalls[1].args, { address: "11 King Street" });
  assert.deepEqual(got.flowNodeIds, ["close"]);
  assert.deepEqual(
    got.assistantTexts.map((t) => t.afterFailure),
    [false, true, true],
  );
});

const failResult: ToolResultInfo = {
  ok: false,
  reason: "invalid_input",
  next: "fallback",
  bad_fields: ["call_ref"],
  raw: "",
};

function evalScenario(assertions: Scenario["assertions"]): Scenario {
  return { id: "t", turns: [], assertions };
}

test("evaluateAssertions: tools_called_include and tools_called_only_from", () => {
  const input = {
    replies: [],
    toolCalls: [{ name: "reserve_technician", args: {} }] as ToolCallRecord[],
    flowNodeIds: [],
  };
  assert.equal(
    evaluateAssertions(evalScenario({ tools_called_include: ["reserve_technician"] }), input)
      .failures.length,
    0,
  );
  const f = evaluateAssertions(
    evalScenario({ tools_called_include: ["create_job"] }),
    input,
  ).failures[0];
  assert.deepEqual([f.assertion, f.detail], ["tools_called_include", "create_job not called"]);
  assert.equal(
    evaluateAssertions(
      evalScenario({ tools_called_only_from: ["reserve_technician", "create_job"] }),
      input,
    ).failures.length,
    0,
  );
  const f2 = evaluateAssertions(
    evalScenario({ tools_called_only_from: ["create_job"] }),
    input,
  ).failures[0];
  assert.equal(f2.assertion, "tools_called_only_from");
  assert.ok(f2.detail.includes("reserve_technician"));
});

test("evaluateAssertions: tool_order checks first calls, ignoring uncalled tools", () => {
  const run = (names: string[]) => ({
    replies: [],
    toolCalls: names.map((name) => ({ name, args: {} })) as ToolCallRecord[],
    flowNodeIds: [],
  });
  const order = { tool_order: ["reserve_technician", "create_job"] };
  assert.equal(
    evaluateAssertions(
      evalScenario(order),
      run(["reserve_technician", "create_job", "reserve_technician"]),
    ).failures.length,
    0,
  );
  assert.equal(evaluateAssertions(evalScenario(order), run(["create_job"])).failures.length, 0);
  const f = evaluateAssertions(
    evalScenario(order),
    run(["create_job", "reserve_technician"]),
  ).failures[0];
  assert.equal(f.assertion, "tool_order");
  assert.ok(f.detail.includes("create_job"));
});

test("evaluateAssertions: no_tool_with_question flags a call riding on a question", () => {
  const s = evalScenario({ no_tool_with_question: true });
  const ok = {
    replies: [],
    toolCalls: [{ name: "reserve_technician", args: {}, text: "Let me check." }],
    flowNodeIds: [],
  };
  assert.equal(evaluateAssertions(s, ok).failures.length, 0);
  const badInput = {
    replies: [],
    toolCalls: [{ name: "reserve_technician", args: {}, text: "Is that number correct?" }],
    flowNodeIds: [],
  };
  const f = evaluateAssertions(s, badInput).failures[0];
  assert.deepEqual([f.assertion, f.detail], ["no_tool_with_question", "reserve_technician"]);
});

test("evaluateAssertions: no_goodbye_with_question works from replies alone", () => {
  const s = evalScenario({ no_goodbye_with_question: true });
  const base = { replies: ["Goodbye and take care."], toolCalls: null, flowNodeIds: [] };
  assert.equal(evaluateAssertions(s, base).failures.length, 0);
  const f = evaluateAssertions(s, { ...base, replies: ["Can I confirm? Goodbye."] }).failures[0];
  assert.equal(f.assertion, "no_goodbye_with_question");
});

test("evaluateAssertions: no_tool_after_failure allows only release_technician", () => {
  const s = evalScenario({ no_tool_after_failure: true });
  const mk = (entries: Array<[string, ToolResultInfo | undefined]>) => ({
    replies: [],
    toolCalls: entries.map(([name, result]) => ({ name, args: {}, result })) as ToolCallRecord[],
    flowNodeIds: [],
  });
  assert.equal(
    evaluateAssertions(s, mk([["reserve_technician", failResult], ["release_technician", undefined]]))
      .failures.length,
    0,
  );
  assert.equal(
    evaluateAssertions(s, mk([["reserve_technician", undefined], ["create_job", undefined]]))
      .failures.length,
    0,
  );
  const f = evaluateAssertions(
    s,
    mk([["reserve_technician", failResult], ["create_job", undefined]]),
  ).failures[0];
  assert.deepEqual([f.assertion, f.detail], ["no_tool_after_failure", "create_job"]);
});

test("evaluateAssertions: success claims and required phrases after a failure", () => {
  const input = {
    replies: [],
    toolCalls: [{ name: "reserve_technician", args: {}, result: failResult }] as ToolCallRecord[],
    flowNodeIds: [],
    assistantTexts: [
      { text: "One moment.", afterFailure: false },
      { text: "I could not reserve anyone; please call during business hours.", afterFailure: true },
    ],
  };
  assert.equal(
    evaluateAssertions(evalScenario({ no_success_claim_after_failure: ["is logged"] }), input)
      .failures.length,
    0,
  );
  const f1 = evaluateAssertions(
    evalScenario({ no_success_claim_after_failure: ["business hours"] }),
    input,
  ).failures[0];
  assert.equal(f1.assertion, "no_success_claim_after_failure");
  assert.equal(
    evaluateAssertions(evalScenario({ failure_reply_contains: ["business hours"] }), input)
      .failures.length,
    0,
  );
  const f2 = evaluateAssertions(
    evalScenario({ failure_reply_contains: ["triple zero"] }),
    input,
  ).failures[0];
  assert.equal(f2.assertion, "failure_reply_contains");
  // No failure: both assertions stay quiet.
  const okInput = {
    ...input,
    toolCalls: [{ name: "reserve_technician", args: {} }] as ToolCallRecord[],
    assistantTexts: [{ text: "Your job is logged.", afterFailure: false }],
  };
  assert.equal(
    evaluateAssertions(
      evalScenario({
        no_success_claim_after_failure: ["is logged"],
        failure_reply_contains: ["triple zero"],
      }),
      okInput,
    ).failures.length,
    0,
  );
});

test("evaluateAssertions: tool_arg_contains if_called skips an uncalled tool", () => {
  const s = (ifCalled: boolean): Scenario =>
    evalScenario({
      tool_arg_contains: [
        { tool: "create_job", field: "hazards", value: "gas", if_called: ifCalled },
      ],
    });
  const input = {
    replies: [],
    toolCalls: [{ name: "reserve_technician", args: {} }] as ToolCallRecord[],
    flowNodeIds: [],
  };
  assert.equal(evaluateAssertions(s(true), input).failures.length, 0);
  assert.equal(evaluateAssertions(s(false), input).failures[0].detail, "create_job not called");
});

test("truncate cuts at the limit", () => {
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("abcd", 3), "abc");
  assert.equal(truncate("x".repeat(400)).length, 300);
});

// Injected fetch that replays canned steps and records every call.
function fakeFetch(steps: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: FetchInit }> = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, init });
    const step =
      steps[calls.length - 1] ?? { status: 500, body: { error: "extra call" } };
    const text =
      typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    return Promise.resolve({
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: () => Promise.resolve(text),
    });
  };
  return { fetchFn, calls };
}

function collect(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line) };
}

test("runScenario: full PASS path stores tools and flow nodes", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { data: { id: "conv-1" } } },
    { status: 200, body: { content: "hello there" } },
    {
      status: 200,
      body: {
        data: [
          {
            tool_calls: [{ name: "create_job", arguments: { address: "11 King Street" } }],
            metadata: { flow_node_id: "job" },
          },
        ],
      },
    },
  ]);
  const { lines, out } = collect();
  const scenario: Scenario = {
    id: "H-test",
    turns: ["hi"],
    assertions: {
      reply_contains: ["hello"],
      tools_called_exactly: ["create_job"],
      tool_arg_contains: [{ tool: "create_job", field: "address", value: "11 King" }],
    },
  };
  const r = await runScenario(fetchFn, cfg, scenario, out);
  assert.equal(r.verdict, "PASS");
  assert.equal(r.conversationId, "conv-1");
  assert.deepEqual(r.replies, ["hello there"]);
  assert.deepEqual(r.toolCalls, [
    { name: "create_job", args: { address: "11 King Street" } },
  ]);
  assert.deepEqual(r.flowNodeIds, ["job"]);
  assert.equal(r.toolAssertionsSkipped, false);
  assert.equal(calls.length, 3);
  assert.ok(lines.some((l) => l === "USER: hi"));
  assert.ok(lines.some((l) => l === "ASSISTANT: hello there"));
  assert.ok(lines.join("\n").includes(KEY) === false, "key leaked into output");
});

test("runScenario: chat 500 marks ERROR, body truncated, no retry", async () => {
  const bigBody = "e".repeat(400);
  const { fetchFn, calls } = fakeFetch([
    { status: 201, body: { id: "conv-1" } },
    { status: 500, body: bigBody },
  ]);
  const { out } = collect();
  const scenario: Scenario = { id: "x", turns: ["hi", "hi again"], assertions: {} };
  const r = await runScenario(fetchFn, cfg, scenario, out);
  assert.equal(r.verdict, "ERROR");
  assert.ok(r.error !== null && r.error.includes("status 500"));
  assert.ok(r.error.includes("e".repeat(300)));
  assert.ok(!r.error.includes("e".repeat(301)));
  assert.equal(calls.length, 2); // no retry, later turns not sent, no messages call
});

test("runScenario: messages 404 skips tool assertions, verdict from replies", async () => {
  const { fetchFn } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "no tools" } },
    { status: 404, body: { errors: [{ detail: "Not Found" }] } },
  ]);
  const { lines, out } = collect();
  const scenario: Scenario = {
    id: "x",
    turns: ["hi"],
    assertions: { tools_called_exactly: [] },
  };
  const r = await runScenario(fetchFn, cfg, scenario, out);
  assert.equal(r.verdict, "PASS");
  assert.equal(r.toolAssertionsSkipped, true);
  assert.ok(lines.some((l) => l.includes("SKIPPED")));
});

test("runScenario: messages with unexpected shape skips tool assertions", async () => {
  const { fetchFn } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "hi" } },
    { status: 200, body: { meta: { page: 1 } } },
  ]);
  const { out } = collect();
  const r = await runScenario(
    fetchFn,
    cfg,
    { id: "x", turns: ["hi"], assertions: { tools_called_exactly: [] } },
    out,
  );
  assert.equal(r.verdict, "PASS");
  assert.equal(r.toolAssertionsSkipped, true);
});

test("runScenario: conversation create failures set createFailed", async () => {
  const { fetchFn: f1 } = fakeFetch([{ status: 401, body: { errors: [{ code: "10001" }] } }]);
  const r1 = await runScenario(f1, cfg, { id: "x", turns: [], assertions: {} }, () => {});
  assert.equal(r1.verdict, "ERROR");
  assert.ok(r1.createFailed !== null && r1.createFailed.status === 401);
  assert.equal(r1.conversationId, null);

  const { fetchFn: f2 } = fakeFetch([{ status: 200, body: { wrong: "shape" } }]);
  const r2 = await runScenario(f2, cfg, { id: "x", turns: [], assertions: {} }, () => {});
  assert.ok(r2.createFailed !== null && r2.createFailed.status === 200);

  const f3: FetchLike = () => Promise.reject(new Error("socket hangup"));
  const r3 = await runScenario(f3, cfg, { id: "x", turns: [], assertions: {} }, () => {});
  assert.ok(r3.createFailed !== null && r3.createFailed.status === 0);
  assert.ok(r3.createFailed.body.includes("socket hangup"));
});

test("runScenario: stops sending scripted turns after a goodbye", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "Thanks, goodbye!" } },
    { status: 200, body: { data: [] } },
  ]);
  const { lines, out } = collect();
  const scenario: Scenario = { id: "x", turns: ["hi", "more", "even more"], assertions: {} };
  const r = await runScenario(fetchFn, cfg, scenario, out);
  assert.equal(r.verdict, "PASS");
  assert.equal(r.replies.length, 1);
  assert.equal(calls.length, 3); // create + one chat + messages; turns 2 and 3 never sent
  assert.ok(lines.some((l) => l === "(assistant ended the call; 2 scripted turns not sent)"));
});

test("formatCallEvidence prints args and result fields in order", () => {
  const line = formatCallEvidence(
    { name: "reserve_technician", args: { urgency: "emergency" }, result: failResult },
    0,
  );
  assert.equal(
    line,
    '  1. reserve_technician {"urgency":"emergency"} -> ok:false reason:invalid_input bad_fields:call_ref',
  );
  assert.ok(formatCallEvidence({ name: "create_job", args: {} }, 1).includes("(no result captured)"));
});

test("callRefRejected drives the no-call-reference NOTE", () => {
  assert.equal(
    callRefRejected([{ name: "reserve_technician", args: {}, result: failResult }]),
    true,
  );
  assert.equal(callRefRejected([{ name: "create_job", args: {} }]), false);
  assert.ok(NO_CALL_REF_NOTE.startsWith("NOTE: chat sends no call reference"));
});

test("parseCliArgs: defaults, --only, --repeat, unknown id and bad values", () => {
  const ids = ["E-01-cleaning", "H-01-gas"];
  assert.deepEqual(parseCliArgs([], ids), { only: null, repeat: 1 });
  assert.deepEqual(parseCliArgs(["--only", "H-01-gas"], ids), {
    only: "H-01-gas",
    repeat: 1,
  });
  assert.deepEqual(parseCliArgs(["--repeat", "3"], ids), { only: null, repeat: 3 });
  assert.deepEqual(parseCliArgs(["--only", "E-01-cleaning", "--repeat", "2"], ids), {
    only: "E-01-cleaning",
    repeat: 2,
  });
  const unknown = parseCliArgs(["--only", "nope"], ids);
  assert.ok("error" in unknown);
  assert.ok(unknown.error.includes('"nope"'));
  assert.ok(unknown.error.includes("E-01-cleaning") && unknown.error.includes("H-01-gas"));
  assert.ok("error" in parseCliArgs(["--only"], ids));
  assert.ok("error" in parseCliArgs(["--repeat"], ids));
  assert.ok("error" in parseCliArgs(["--repeat", "0"], ids));
  assert.ok("error" in parseCliArgs(["--repeat", "-2"], ids));
  assert.ok("error" in parseCliArgs(["--repeat", "abc"], ids));
  assert.ok("error" in parseCliArgs(["--wat"], ids));
});

test("aggregateRuns: a scenario passes only if every repeat passes", () => {
  assert.deepEqual(aggregateRuns(["PASS"]), { passed: 1, verdict: "PASS" });
  assert.deepEqual(aggregateRuns(["PASS", "PASS", "PASS"]), {
    passed: 3,
    verdict: "PASS",
  });
  assert.deepEqual(aggregateRuns(["PASS", "FAIL", "PASS"]), {
    passed: 2,
    verdict: "FAIL",
  });
  assert.deepEqual(aggregateRuns(["PASS", "ERROR", "PASS"]), {
    passed: 2,
    verdict: "ERROR",
  });
  assert.deepEqual(aggregateRuns(["ERROR", "ERROR"]), { passed: 0, verdict: "ERROR" });
});

// ---- routed caller (T1.0d) ----

const callerDoc = (overrides: Record<string, unknown> = {}) => ({
  id: "c",
  golden_id: null,
  caller: {
    opening: "hi",
    routes: [{ when: ["safe"], say: ["we are safe"] }],
    unmatched: "say again?",
    max_turns: 5,
  },
  assertions: {},
  ...overrides,
});

test("parseScenarios: caller parses; both/neither/bad routes rejected", () => {
  const good = parseScenarios({ scenarios: [callerDoc()] });
  assert.equal(good[0].caller?.opening, "hi");
  assert.equal(good[0].turns, undefined);
  // Both fields, and neither field, are rejected.
  assert.throws(() => parseScenarios({ scenarios: [callerDoc({ turns: ["x"] })] }));
  assert.throws(() =>
    parseScenarios({ scenarios: [{ id: "c", golden_id: null, assertions: {} }] }),
  );
  // A route without a non-empty when or say is rejected.
  assert.throws(() =>
    parseScenarios({
      scenarios: [
        callerDoc({
          caller: { opening: "hi", routes: [{ when: [], say: ["a"] }], unmatched: "u", max_turns: 5 },
        }),
      ],
    }),
  );
  assert.throws(() =>
    parseScenarios({
      scenarios: [
        callerDoc({
          caller: { opening: "hi", routes: [{ when: ["a"], say: [] }], unmatched: "u", max_turns: 5 },
        }),
      ],
    }),
  );
});

test("extractQuestion: last question wins; no question returns the whole reply", () => {
  assert.equal(extractQuestion("You are safe, right? Is that correct?"), "Is that correct?");
  assert.equal(extractQuestion("No question here."), "No question here.");
  assert.equal(extractQuestion("Is anyone hurt?"), "Is anyone hurt?");
});

test("pickCallerRoute: file order, when_not, and scope reply", () => {
  const inOrder: CallerRoute[] = [
    { when: ["address"], say: ["a"] },
    { when: ["address", "king"], say: ["b"] },
  ];
  assert.equal(pickCallerRoute(inOrder, "Is that address right?"), 0);
  const neg: CallerRoute[] = [{ when: ["king"], when_not: ["eleven"], say: ["x"] }];
  assert.equal(pickCallerRoute(neg, "Is Eleven King Street right?"), -1);
  assert.equal(pickCallerRoute(neg, "Is Leven King Street right?"), 0);
  // Without scope the keyword lives outside the question; scope reply sees it.
  const reply = "You said Leven King Street. Is that right?";
  assert.equal(pickCallerRoute([{ when: ["leven king"], say: ["x"] }], reply), -1);
  assert.equal(pickCallerRoute([{ when: ["leven king"], scope: "reply", say: ["x"] }], reply), 0);
});

test("routeSay: nth fire uses the nth entry; the last entry repeats", () => {
  const route: CallerRoute = { when: ["a"], say: ["one", "two"] };
  assert.equal(routeSay(route, 1), "one");
  assert.equal(routeSay(route, 2), "two");
  assert.equal(routeSay(route, 5), "two");
});

function callerScenario(
  overrides: Partial<CallerScript> = {},
  assertions: Scenario["assertions"] = {},
): Scenario {
  return {
    id: "c",
    caller: {
      opening: "I smell gas.",
      routes: [
        { when: ["safe"], say: ["We are safe."] },
        { when: ["correct"], say: ["Yes."] },
      ],
      unmatched: "Say again?",
      max_turns: 10,
      ...overrides,
    },
    assertions,
  };
}

test("runScenario: routed caller answers from routes, stops on goodbye", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "Is anyone safe right now?" } },
    { status: 200, body: { content: "Is the address correct?" } },
    { status: 200, body: { content: "All set, goodbye!" } },
    { status: 200, body: { data: [] } },
  ]);
  const { lines, out } = collect();
  const r = await runScenario(fetchFn, cfg, callerScenario(), out);
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(r.replies, [
    "Is anyone safe right now?",
    "Is the address correct?",
    "All set, goodbye!",
  ]);
  assert.equal(calls.length, 5); // create + 3 chats + messages
  assert.ok(lines.some((l) => l === "USER: I smell gas."));
  assert.ok(lines.some((l) => l === "USER (routed): We are safe."));
  assert.ok(lines.some((l) => l === "USER (routed): Yes."));
});

test("runScenario: third unmatched reply stops with caller_script_unmatched", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "uh?" } },
    { status: 200, body: { content: "pardon?" } },
    { status: 200, body: { content: "x".repeat(250) } },
    { status: 200, body: { data: [] } },
  ]);
  const { lines, out } = collect();
  const r = await runScenario(
    fetchFn,
    cfg,
    callerScenario({ routes: [{ when: ["zzzzz"], say: ["a"] }] }),
    out,
  );
  assert.equal(r.verdict, "FAIL");
  const f = r.failures.find((x) => x.assertion === "caller_script_unmatched");
  assert.ok(f !== undefined);
  assert.equal(f.detail, "x".repeat(200)); // last assistant reply, truncated
  assert.equal(calls.length, 5); // create + opening + two unmatched sends + messages
  assert.equal(lines.filter((l) => l === "USER: Say again?").length, 2);
  assert.ok(lines.some((l) => l.includes("harness gap, not necessarily an assistant fault")));
});

test("runScenario: max_turns caps a caller run", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "Are you safe?" } },
    { status: 200, body: { content: "Are you safe right now?" } },
    { status: 200, body: { data: [] } },
  ]);
  const { lines, out } = collect();
  const r = await runScenario(
    fetchFn,
    cfg,
    callerScenario({ routes: [{ when: ["safe"], say: ["ok"] }], max_turns: 2 }),
    out,
  );
  assert.equal(r.verdict, "PASS");
  assert.equal(r.replies.length, 2);
  assert.equal(calls.length, 4); // create + 2 chats + messages
  assert.ok(lines.some((l) => l.includes("max_turns 2")));
});

test("runScenario: turns scenarios behave exactly as before", async () => {
  const { fetchFn, calls } = fakeFetch([
    { status: 200, body: { id: "conv-1" } },
    { status: 200, body: { content: "first answer" } },
    { status: 200, body: { content: "second answer" } },
    { status: 200, body: { data: [] } },
  ]);
  const { lines, out } = collect();
  const r = await runScenario(
    fetchFn,
    cfg,
    { id: "t", turns: ["hi", "again"], assertions: {} },
    out,
  );
  assert.equal(r.verdict, "PASS");
  assert.equal(calls.length, 4); // create + 2 chats + messages
  assert.ok(lines.some((l) => l === "USER: hi"));
  assert.ok(lines.some((l) => l === "USER: again"));
  assert.ok(!lines.some((l) => l.startsWith("USER (routed):")));
});

test("golden_id is present on every scenario in scenarios.json (null allowed)", async () => {
  const url = new URL("./chat/scenarios.json", import.meta.url);
  const raw: unknown = JSON.parse(await readFile(url, "utf8"));
  const scenarios = parseScenarios(raw); // throws if any golden_id is missing
  for (const s of scenarios) {
    assert.ok(
      s.golden_id === null || typeof s.golden_id === "string",
      `${s.id} golden_id must be a string or null`,
    );
  }
  // Register mapping is the one from the task spec.
  const map = new Map(scenarios.map((s) => [s.id, s.golden_id]));
  assert.equal(map.get("E-01-cleaning"), "E-01");
  assert.equal(map.get("E-02-can-wait"), "C-09");
  assert.equal(map.get("E-03-abusive"), null);
  assert.equal(map.get("E-04-injection"), "C-11");
  assert.equal(map.get("H-01-gas"), "C-01");
  assert.equal(map.get("H-02-flood"), "C-02");
  assert.equal(map.get("G-01-correction"), "C-05");
});
