// scripts/chat-test-lib.ts
// Pure helpers for the T1.0 chat test harness: request builders, defensive
// response extractors, assertion evaluation and the per-scenario run flow.
// fetch is injected (global fetch in the runner, a fake in unit tests). The
// API key only ever leaves this file inside an Authorization header; it is
// never printed, logged or put in a URL or body.

export const DEFAULT_ASSISTANT_ID =
  "assistant-14327cf7-7f6c-4fc6-b080-46739673d578";
export const DEFAULT_BASE_URL = "https://api.telnyx.com";
export const REQUEST_TIMEOUT_MS = 90_000;
export const ERROR_BODY_MAX = 300;

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface ToolArgAssertion {
  tool: string;
  field: string;
  value: string | string[]; // a list means: any one of these
  if_called?: boolean; // tool_arg_contains only: skip when that tool was never called
}

export interface ScenarioAssertions {
  reply_contains?: string[];
  reply_not_contains?: string[];
  tools_called_exactly?: string[];
  tools_called_include?: string[];
  tools_called_only_from?: string[];
  tool_order?: string[];
  no_tool_with_question?: boolean;
  no_goodbye_with_question?: boolean;
  no_tool_after_failure?: boolean;
  no_success_claim_after_failure?: string[];
  failure_reply_contains?: string[];
  tool_arg_contains?: ToolArgAssertion[];
  tool_arg_not_contains?: ToolArgAssertion[];
  max_assistant_turns?: number;
}

export interface CallerRoute {
  when: string[]; // lower-case keywords; any one is a substring match
  when_not?: string[];
  scope?: "question" | "reply"; // default "question"
  say: string[]; // nth fire uses the nth entry; the last entry repeats
}

export interface CallerScript {
  opening: string;
  routes: CallerRoute[];
  unmatched: string;
  max_turns: number;
}

export interface Scenario {
  id: string;
  golden_id?: string | null;
  turns?: string[]; // exactly one of turns or caller
  caller?: CallerScript;
  assertions: ScenarioAssertions;
}

export interface RunnerConfig {
  apiKey: string;
  assistantId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ToolResultInfo {
  ok: boolean | null;
  reason: string | null;
  next: string | null;
  bad_fields: string[];
  raw: string; // the tool response text, truncated
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  text?: string; // assistant text riding on the same stored message
  result?: ToolResultInfo; // the paired role:"tool" message, matched by tool_call_id
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function truncate(s: string, max: number = ERROR_BODY_MAX): string {
  return s.length <= max ? s : s.slice(0, max);
}

// ---- request builders ----

function headers(cfg: RunnerConfig): Record<string, string> {
  return {
    authorization: `Bearer ${cfg.apiKey}`,
    "content-type": "application/json",
  };
}

function base(cfg: RunnerConfig): string {
  return cfg.baseUrl ?? DEFAULT_BASE_URL;
}

export function createConversationRequest(
  cfg: RunnerConfig,
  scenarioId: string,
): { url: string; init: FetchInit } {
  return {
    url: `${base(cfg)}/v2/ai/conversations`,
    init: {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({
        name: `chat-test ${scenarioId}`,
        metadata: {
          assistant_id: cfg.assistantId,
          telnyx_conversation_channel: "web_chat",
        },
      }),
    },
  };
}

export function chatRequest(
  cfg: RunnerConfig,
  conversationId: string,
  content: string,
): { url: string; init: FetchInit } {
  return {
    url: `${base(cfg)}/v2/ai/assistants/${cfg.assistantId}/chat`,
    init: {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ content, conversation_id: conversationId }),
    },
  };
}

export function messagesRequest(
  cfg: RunnerConfig,
  conversationId: string,
): { url: string; init: FetchInit } {
  return {
    url: `${base(cfg)}/v2/ai/conversations/${conversationId}/messages`,
    init: { method: "GET", headers: headers(cfg) },
  };
}

// ---- response extractors (shape is not documented, so stay defensive) ----

export function responseKeys(body: unknown): string {
  if (isRecord(body)) return Object.keys(body).join(",");
  return Array.isArray(body) ? "(array)" : `(${typeof body})`;
}

// Conversation id: accept data.id or id.
export function extractConversationId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.id === "string" && body.id !== "") return body.id;
  const data = body.data;
  if (isRecord(data) && typeof data.id === "string" && data.id !== "") {
    return data.id;
  }
  return null;
}

// Assistant text: accept content / data.content / message.content /
// choices[0].message.content.
export function extractAssistantContent(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.content === "string") return body.content;
  if (isRecord(body.data) && typeof body.data.content === "string") {
    return body.data.content;
  }
  if (isRecord(body.message) && typeof body.message.content === "string") {
    return body.message.content;
  }
  if (Array.isArray(body.choices)) {
    const first: unknown = body.choices[0];
    if (
      isRecord(first) &&
      isRecord(first.message) &&
      typeof first.message.content === "string"
    ) {
      return first.message.content;
    }
  }
  return null;
}

export interface AssistantText {
  text: string;
  afterFailure: boolean; // true once any earlier tool result had ok === false
}

export interface MessagesExtraction {
  toolCalls: ToolCallRecord[];
  flowNodeIds: string[];
  assistantTexts: AssistantText[]; // chronological assistant texts from stored messages
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON: no usable args
    }
  }
  return {};
}

function msgText(msg: Record<string, unknown>): string {
  if (typeof msg.content === "string") return msg.content;
  if (typeof msg.text === "string") return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

// role:"tool" message: pairing key (tool_call_id) plus the JSON payload
// parsed into ok / reason / next / bad_fields; the raw text is kept truncated.
// The payload may be an object or an array holding one object.
export function parseToolResult(msg: Record<string, unknown>): { id: string | null; info: ToolResultInfo } {
  const idRaw = msg.tool_call_id ?? msg.toolCallId;
  const id = typeof idRaw === "string" && idRaw !== "" ? idRaw : null;
  const text = msgText(msg);
  const info: ToolResultInfo = {
    ok: null,
    reason: null,
    next: null,
    bad_fields: [],
    raw: truncate(text, 150),
  };
  try {
    const parsed: unknown = JSON.parse(text);
    const obj: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    if (isRecord(obj)) {
      if (typeof obj.ok === "boolean") info.ok = obj.ok;
      if (typeof obj.reason === "string") info.reason = obj.reason;
      if (typeof obj.next === "string") info.next = obj.next;
      if (Array.isArray(obj.bad_fields)) {
        info.bad_fields = obj.bad_fields.filter((x): x is string => typeof x === "string");
      }
    }
  } catch {
    // not JSON: fields stay null, raw keeps the text
  }
  return { id, info };
}

// Tool calls (from tool_calls / toolCalls, OpenAI-style function wrapped or
// flat), tool results paired by tool_call_id, assistant texts and flow node
// ids. The endpoint returns newest first: reverse once so every list built
// here is chronological. Flow node id is read from
// metadata.active_flow_node_id first (the key live data really carries),
// then the older keys. Null when no message list is recognisable.
export function extractMessages(body: unknown): MessagesExtraction | null {
  let list: unknown[] | null = null;
  if (Array.isArray(body)) list = body;
  else if (isRecord(body) && Array.isArray(body.data)) list = body.data;
  else if (isRecord(body) && Array.isArray(body.messages)) list = body.messages;
  if (list === null) return null;
  const chronological = [...list].reverse();

  const resultsById = new Map<string, ToolResultInfo>();
  const unattributed: ToolResultInfo[] = [];
  for (const msg of chronological) {
    if (!isRecord(msg) || msg.role !== "tool") continue;
    const r = parseToolResult(msg);
    if (r.id !== null) resultsById.set(r.id, r.info);
    else unattributed.push(r.info);
  }

  const toolCalls: ToolCallRecord[] = [];
  const flowNodeIds: string[] = [];
  const assistantTexts: AssistantText[] = [];
  let failureSeen = false;
  for (const msg of chronological) {
    if (!isRecord(msg)) continue;
    if (msg.role === "tool") {
      const { info } = parseToolResult(msg);
      if (info.ok === false) failureSeen = true;
      continue;
    }
    const text = msgText(msg);
    const calls = msg.tool_calls ?? msg.toolCalls;
    const hadCalls = Array.isArray(calls) && calls.length > 0;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : call;
        const name = typeof fn.name === "string" ? fn.name : null;
        if (name === null) continue;
        const rec: ToolCallRecord = {
          name,
          args: parseToolArgs(fn.arguments ?? fn.input),
        };
        if (text !== "") rec.text = text;
        const idRaw = call.id ?? call.tool_call_id ?? fn.id;
        const id = typeof idRaw === "string" && idRaw !== "" ? idRaw : null;
        if (id !== null && resultsById.has(id)) {
          rec.result = resultsById.get(id);
        } else if (unattributed.length > 0) {
          rec.result = unattributed.shift();
        }
        toolCalls.push(rec);
      }
    }
    if (msg.role === "assistant" && (text !== "" || hadCalls)) {
      assistantTexts.push({ text, afterFailure: failureSeen });
    }
    const meta = isRecord(msg.metadata) ? msg.metadata : null;
    const node =
      meta !== null && typeof meta.active_flow_node_id === "string"
        ? meta.active_flow_node_id
        : typeof msg.flow_node_id === "string"
          ? msg.flow_node_id
          : meta !== null && typeof meta.flow_node_id === "string"
            ? meta.flow_node_id
            : null;
    if (node !== null && node !== "" && !flowNodeIds.includes(node)) {
      flowNodeIds.push(node);
    }
  }
  return { toolCalls, flowNodeIds, assistantTexts };
}

// ---- scenario file ----

// Every scenario must carry golden_id (null allowed) so the chat harness
// stays mapped to the edge-case/test register, and exactly one of turns
// (fixed script) or caller (opening + keyword routes).
export function parseScenarios(raw: unknown): Scenario[] {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) {
    throw new Error("scenarios.json: missing scenarios array");
  }
  const scenarios: Scenario[] = [];
  for (const s of raw.scenarios) {
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      !isRecord(s.assertions) ||
      !("golden_id" in s) ||
      (s.golden_id !== null && typeof s.golden_id !== "string")
    ) {
      throw new Error("scenarios.json: bad scenario shape");
    }
    const hasTurns = s.turns !== undefined;
    const hasCaller = s.caller !== undefined;
    if (hasTurns === hasCaller) {
      throw new Error("scenarios.json: bad scenario shape");
    }
    const scenario: Scenario = {
      id: s.id,
      golden_id: s.golden_id as string | null,
      assertions: s.assertions as ScenarioAssertions,
    };
    if (hasTurns) {
      if (!Array.isArray(s.turns) || s.turns.some((t) => typeof t !== "string")) {
        throw new Error("scenarios.json: bad scenario shape");
      }
      scenario.turns = s.turns as string[];
    } else {
      scenario.caller = parseCaller(s.caller);
    }
    scenarios.push(scenario);
  }
  return scenarios;
}

function parseCaller(raw: unknown): CallerScript {
  if (
    !isRecord(raw) ||
    typeof raw.opening !== "string" ||
    !Array.isArray(raw.routes) ||
    typeof raw.unmatched !== "string" ||
    typeof raw.max_turns !== "number" ||
    !Number.isInteger(raw.max_turns) ||
    raw.max_turns < 1
  ) {
    throw new Error("scenarios.json: bad scenario shape");
  }
  const routes: CallerRoute[] = [];
  for (const r of raw.routes) {
    if (
      !isRecord(r) ||
      !Array.isArray(r.when) ||
      r.when.length === 0 ||
      r.when.some((k) => typeof k !== "string") ||
      !Array.isArray(r.say) ||
      r.say.length === 0 ||
      r.say.some((k) => typeof k !== "string") ||
      (r.when_not !== undefined &&
        (!Array.isArray(r.when_not) || r.when_not.some((k) => typeof k !== "string"))) ||
      (r.scope !== undefined && r.scope !== "question" && r.scope !== "reply")
    ) {
      throw new Error("scenarios.json: bad scenario shape");
    }
    routes.push({
      when: r.when as string[],
      ...(r.when_not !== undefined ? { when_not: r.when_not as string[] } : {}),
      ...(r.scope !== undefined ? { scope: r.scope as "question" | "reply" } : {}),
      say: r.say as string[],
    });
  }
  return { opening: raw.opening, routes, unmatched: raw.unmatched, max_turns: raw.max_turns };
}

// ---- assertion evaluation ----
// Reply assertions are case-insensitive substring matches. Tool-arg
// assertions are case-insensitive with token boundaries: the value must not
// be preceded or followed by a letter or digit ("gas" matches "Gas smell
// reported."; "11" does not match "111 King Street"; "Leven King" does not
// match "Eleven King Street").

export function tokenMatch(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n === "") return false;
  const alnum = (ch: string): boolean => /[a-z0-9]/.test(ch);
  let idx = h.indexOf(n);
  while (idx !== -1) {
    const before = idx === 0 ? "" : h.charAt(idx - 1);
    const after = idx + n.length >= h.length ? "" : h.charAt(idx + n.length);
    if (!alnum(before) && !alnum(after)) return true;
    idx = h.indexOf(n, idx + 1);
  }
  return false;
}

export interface AssertionFailure {
  assertion: string;
  detail: string;
}

export interface EvalInput {
  replies: string[];
  toolCalls: ToolCallRecord[] | null; // null: messages endpoint unavailable
  flowNodeIds: string[];
  assistantTexts?: AssistantText[]; // chronological stored assistant texts
}

export interface AssertionEval {
  failures: AssertionFailure[];
  skipped: string[];
}

function values(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

function argText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return JSON.stringify(v) ?? "";
}

function toolArgFailure(
  kind: string,
  a: ToolArgAssertion,
  calls: ToolCallRecord[],
  negate: boolean,
): AssertionFailure | null {
  const own = calls.filter((c) => c.name === a.tool);
  if (own.length === 0) {
    if (negate || a.if_called === true) return null;
    return { assertion: kind, detail: `${a.tool} not called` };
  }
  for (const want of values(a.value)) {
    const hit = own.some((c) => tokenMatch(argText(c.args[a.field]), want));
    if (negate && hit) {
      return {
        assertion: kind,
        detail: `${a.tool}.${a.field} contains ${JSON.stringify(want)}`,
      };
    }
    if (!negate && hit) return null;
  }
  return negate
    ? null
    : {
        assertion: kind,
        detail: `${a.tool}.${a.field} missing ${values(a.value).join(" | ")}`,
      };
}

export function evaluateAssertions(
  scenario: Scenario,
  input: EvalInput,
): AssertionEval {
  const a = scenario.assertions;
  const failures: AssertionFailure[] = [];
  const skipped: string[] = [];
  const blob = input.replies.join("\n").toLowerCase();
  for (const needle of a.reply_contains ?? []) {
    if (!blob.includes(needle.toLowerCase())) {
      failures.push({ assertion: "reply_contains", detail: needle });
    }
  }
  for (const needle of a.reply_not_contains ?? []) {
    if (blob.includes(needle.toLowerCase())) {
      failures.push({ assertion: "reply_not_contains", detail: needle });
    }
  }
  if (
    a.max_assistant_turns !== undefined &&
    input.replies.length > a.max_assistant_turns
  ) {
    failures.push({
      assertion: "max_assistant_turns",
      detail: `${input.replies.length} > ${a.max_assistant_turns}`,
    });
  }
  if (a.no_goodbye_with_question === true) {
    for (const r of input.replies) {
      if (/goodbye/i.test(r) && r.includes("?")) {
        failures.push({
          assertion: "no_goodbye_with_question",
          detail: JSON.stringify(truncate(r, 80)),
        });
      }
    }
  }
  if (input.toolCalls === null) {
    if (a.tools_called_exactly !== undefined) skipped.push("tools_called_exactly");
    if (a.tools_called_include !== undefined) skipped.push("tools_called_include");
    if (a.tools_called_only_from !== undefined) skipped.push("tools_called_only_from");
    if (a.tool_order !== undefined) skipped.push("tool_order");
    if (a.no_tool_with_question === true) skipped.push("no_tool_with_question");
    if (a.no_tool_after_failure === true) skipped.push("no_tool_after_failure");
    if (a.no_success_claim_after_failure !== undefined) {
      skipped.push("no_success_claim_after_failure");
    }
    if (a.failure_reply_contains !== undefined) skipped.push("failure_reply_contains");
    for (const x of a.tool_arg_contains ?? []) skipped.push(`tool_arg_contains ${x.tool}.${x.field}`);
    for (const x of a.tool_arg_not_contains ?? []) skipped.push(`tool_arg_not_contains ${x.tool}.${x.field}`);
  } else {
    const calls = input.toolCalls;
    if (a.tools_called_exactly !== undefined) {
      const actual = calls.map((c) => c.name).sort();
      const want = [...a.tools_called_exactly].sort();
      if (actual.length !== want.length || actual.some((n, i) => n !== want[i])) {
        failures.push({
          assertion: "tools_called_exactly",
          detail: `want [${a.tools_called_exactly.join(",")}] got [${calls.map((c) => c.name).join(",")}]`,
        });
      }
    }
    if (a.tools_called_include !== undefined) {
      for (const name of a.tools_called_include) {
        if (!calls.some((c) => c.name === name)) {
          failures.push({ assertion: "tools_called_include", detail: `${name} not called` });
        }
      }
    }
    if (a.tools_called_only_from !== undefined) {
      const allowed = new Set(a.tools_called_only_from);
      const outside = calls.map((c) => c.name).filter((n) => !allowed.has(n));
      if (outside.length > 0) {
        failures.push({
          assertion: "tools_called_only_from",
          detail: `unexpected: ${outside.join(",")}`,
        });
      }
    }
    if (a.tool_order !== undefined) {
      const firstIdx = new Map<string, number>();
      calls.forEach((c, i) => {
        if (!firstIdx.has(c.name)) firstIdx.set(c.name, i);
      });
      const seen = a.tool_order
        .filter((n) => firstIdx.has(n))
        .map((n) => ({ name: n, idx: firstIdx.get(n) as number }));
      for (let k = 1; k < seen.length; k++) {
        if (seen[k].idx <= seen[k - 1].idx) {
          failures.push({
            assertion: "tool_order",
            detail: `${seen[k].name} called before ${seen[k - 1].name}`,
          });
        }
      }
    }
    if (a.no_tool_with_question === true) {
      for (const c of calls) {
        if ((c.text ?? "").includes("?")) {
          failures.push({ assertion: "no_tool_with_question", detail: c.name });
        }
      }
    }
    const firstFailure = calls.findIndex((c) => c.result?.ok === false);
    if (a.no_tool_after_failure === true && firstFailure !== -1) {
      for (const c of calls.slice(firstFailure + 1)) {
        if (c.name !== "release_technician") {
          failures.push({ assertion: "no_tool_after_failure", detail: c.name });
        }
      }
    }
    const afterFailureText = (input.assistantTexts ?? [])
      .filter((t) => t.afterFailure)
      .map((t) => t.text)
      .join("\n")
      .toLowerCase();
    if (a.no_success_claim_after_failure !== undefined && firstFailure !== -1) {
      for (const needle of a.no_success_claim_after_failure) {
        if (afterFailureText.includes(needle.toLowerCase())) {
          failures.push({
            assertion: "no_success_claim_after_failure",
            detail: JSON.stringify(needle),
          });
        }
      }
    }
    if (a.failure_reply_contains !== undefined && firstFailure !== -1) {
      for (const needle of a.failure_reply_contains) {
        if (!afterFailureText.includes(needle.toLowerCase())) {
          failures.push({
            assertion: "failure_reply_contains",
            detail: JSON.stringify(needle),
          });
        }
      }
    }
    for (const x of a.tool_arg_contains ?? []) {
      const f = toolArgFailure("tool_arg_contains", x, calls, false);
      if (f !== null) failures.push(f);
    }
    for (const x of a.tool_arg_not_contains ?? []) {
      const f = toolArgFailure("tool_arg_not_contains", x, calls, true);
      if (f !== null) failures.push(f);
    }
  }
  return { failures, skipped };
}

// ---- printed evidence ----

export const NO_CALL_REF_NOTE =
  "NOTE: chat sends no call reference, so tool calls are rejected here. The success path can only be tested by voice.";

export function callRefRejected(calls: ToolCallRecord[]): boolean {
  return calls.some((c) => c.result?.bad_fields.includes("call_ref") === true);
}

// One evidence line per tool call, in chronological order.
export function formatCallEvidence(call: ToolCallRecord, index: number): string {
  const args = truncate(JSON.stringify(call.args), 300);
  const r = call.result;
  if (r === undefined) return `  ${index + 1}. ${call.name} ${args} -> (no result captured)`;
  const parts: string[] = [];
  if (r.ok !== null) parts.push(`ok:${r.ok}`);
  if (r.reason !== null) parts.push(`reason:${r.reason}`);
  if (r.bad_fields.length > 0) parts.push(`bad_fields:${r.bad_fields.join(",")}`);
  const tail = parts.length > 0 ? parts.join(" ") : truncate(r.raw, 150);
  return `  ${index + 1}. ${call.name} ${args} -> ${tail}`;
}

// ---- routed caller (T1.0d) ----

// The "question": the last sentence of the reply that ends in "?", else the
// whole reply.
export function extractQuestion(reply: string): string {
  const q = reply.lastIndexOf("?");
  if (q === -1) return reply.trim();
  const start =
    Math.max(
      reply.lastIndexOf(".", q),
      reply.lastIndexOf("!", q),
      reply.lastIndexOf("?", q - 1),
      reply.lastIndexOf("\n", q),
    ) + 1;
  return reply.slice(start, q + 1).trim();
}

// First route, in file order, where any when keyword is a substring of the
// subject and no when_not keyword is. The subject is the question, or the
// whole reply for scope "reply". -1 when nothing matches.
export function pickCallerRoute(routes: CallerRoute[], reply: string): number {
  const question = extractQuestion(reply).toLowerCase();
  const whole = reply.toLowerCase();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const subject = r.scope === "reply" ? whole : question;
    if (
      r.when.some((kw) => subject.includes(kw)) &&
      !(r.when_not ?? []).some((kw) => subject.includes(kw))
    ) {
      return i;
    }
  }
  return -1;
}

// firedCount is 1-based: the first fire uses say[0] and past the end of the
// list the last entry repeats.
export function routeSay(route: CallerRoute, firedCount: number): string {
  return route.say[Math.min(firedCount - 1, route.say.length - 1)];
}

// ---- per-scenario run flow ----

export interface ScenarioResult {
  id: string;
  verdict: "PASS" | "FAIL" | "ERROR";
  conversationId: string | null;
  createFailed: { status: number; body: string } | null; // stops the run on scenario 1
  error: string | null;
  replies: string[];
  toolCalls: ToolCallRecord[];
  flowNodeIds: string[];
  toolAssertionsSkipped: boolean;
  failures: AssertionFailure[];
}

async function readBody(res: FetchResponse): Promise<{ body: unknown; text: string }> {
  const text = await res.text();
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
}

async function post(
  fetchFn: FetchLike,
  req: { url: string; init: FetchInit },
  timeoutMs: number,
): Promise<{ res: FetchResponse | null; error: string | null }> {
  try {
    const res = await fetchFn(req.url, {
      ...req.init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { res, error: null };
  } catch (err) {
    return { res: null, error: errMessage(err) };
  }
}

// One chat round-trip; the error strings are the run's ERROR lines.
async function chatRound(
  fetchFn: FetchLike,
  cfg: RunnerConfig,
  cid: string,
  line: string,
  timeoutMs: number,
): Promise<{ content: string; error: null } | { content: null; error: string }> {
  const t = await post(fetchFn, chatRequest(cfg, cid, line), timeoutMs);
  if (t.res === null) return { content: null, error: `chat: ${t.error}` };
  const tBody = await readBody(t.res);
  if (!t.res.ok) {
    return { content: null, error: `chat: status ${t.res.status} ${truncate(tBody.text)}` };
  }
  const content = extractAssistantContent(tBody.body);
  if (content === null) {
    return {
      content: null,
      error: `chat: no assistant content; keys: ${responseKeys(tBody.body)}`,
    };
  }
  return { content, error: null };
}

export async function runScenario(
  fetchFn: FetchLike,
  cfg: RunnerConfig,
  scenario: Scenario,
  out: (line: string) => void,
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    id: scenario.id,
    verdict: "ERROR",
    conversationId: null,
    createFailed: null,
    error: null,
    replies: [],
    toolCalls: [],
    flowNodeIds: [],
    toolAssertionsSkipped: false,
    failures: [],
  };
  const timeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // 1. new conversation
  const cReq = createConversationRequest(cfg, scenario.id);
  const c = await post(fetchFn, cReq, timeoutMs);
  if (c.res === null) {
    result.createFailed = { status: 0, body: truncate(c.error ?? "unknown") };
    out(`ERROR conversation create: ${result.createFailed.body}`);
    return result;
  }
  const cBody = await readBody(c.res);
  const cid = extractConversationId(cBody.body);
  if (!c.res.ok || cid === null) {
    result.createFailed = {
      status: c.res.status,
      body: truncate(cBody.text),
    };
    out(
      cid === null && c.res.ok
        ? `ERROR conversation create: no id in response; keys: ${responseKeys(cBody.body)}`
        : `ERROR conversation create: status ${c.res.status} ${truncate(cBody.text)}`,
    );
    return result;
  }
  result.conversationId = cid;

  // 2. user turns; chat has no hangup, so a "goodbye" from the assistant
  // ends the run: the remaining scripted turns are not sent. Caller-script
  // scenarios answer each reply from the keyword routes instead.
  let callerGap: string | null = null; // last reply when caller_script_unmatched stops the run
  if (scenario.caller !== undefined) {
    const caller = scenario.caller;
    const fired = caller.routes.map(() => 0);
    let unmatchedCount = 0;
    let sentCount = 0;
    let pending = { line: caller.opening, prefix: "USER" };
    for (;;) {
      sentCount += 1;
      out(`${pending.prefix}: ${pending.line}`);
      const r = await chatRound(fetchFn, cfg, cid, pending.line, timeoutMs);
      if (r.error !== null) {
        result.error = r.error;
        out(`ERROR ${r.error}`);
        return result;
      }
      result.replies.push(r.content);
      out(`ASSISTANT: ${r.content}`);
      if (/goodbye/i.test(r.content)) break;
      if (sentCount >= caller.max_turns) {
        out(`(caller max_turns ${caller.max_turns} reached; stopping)`);
        break;
      }
      const idx = pickCallerRoute(caller.routes, r.content);
      if (idx === -1) {
        unmatchedCount += 1;
        if (unmatchedCount >= 3) {
          callerGap = truncate(r.content, 200);
          out("caller_script_unmatched: harness gap, not necessarily an assistant fault");
          break;
        }
        pending = { line: caller.unmatched, prefix: "USER" };
        continue;
      }
      fired[idx] += 1;
      pending = { line: routeSay(caller.routes[idx], fired[idx]), prefix: "USER (routed)" };
    }
  } else {
    const turns = scenario.turns ?? [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      out(`USER: ${turn}`);
      const r = await chatRound(fetchFn, cfg, cid, turn, timeoutMs);
      if (r.error !== null) {
        result.error = r.error;
        out(`ERROR ${r.error}`);
        return result;
      }
      result.replies.push(r.content);
      out(`ASSISTANT: ${r.content}`);
      if (/goodbye/i.test(r.content)) {
        const notSent = turns.length - (i + 1);
        if (notSent > 0) {
          out(`(assistant ended the call; ${notSent} scripted turns not sent)`);
        }
        break;
      }
    }
  }

  // 3. stored messages: 404 or an unexpected shape skips tool assertions
  let toolCalls: ToolCallRecord[] | null = null;
  let assistantTexts: AssistantText[] | undefined;
  const m = await post(fetchFn, messagesRequest(cfg, cid), timeoutMs);
  if (m.res === null) {
    out(`messages: request failed (${m.error}); tool assertions SKIPPED`);
  } else if (!m.res.ok) {
    const mBody = await readBody(m.res);
    out(
      `messages: status ${m.res.status} ${truncate(mBody.text)}; keys: ${responseKeys(mBody.body)}; tool assertions SKIPPED`,
    );
  } else {
    const mBody = await readBody(m.res);
    const extracted = extractMessages(mBody.body);
    if (extracted === null) {
      out(`messages: unexpected shape; keys: ${responseKeys(mBody.body)}; tool assertions SKIPPED`);
    } else {
      toolCalls = extracted.toolCalls;
      result.toolCalls = extracted.toolCalls;
      result.flowNodeIds = extracted.flowNodeIds;
      assistantTexts = extracted.assistantTexts;
    }
  }

  // 4. assertions
  const evalResult = evaluateAssertions(scenario, {
    replies: result.replies,
    toolCalls,
    flowNodeIds: result.flowNodeIds,
    assistantTexts,
  });
  result.failures = evalResult.failures;
  if (callerGap !== null) {
    result.failures.push({ assertion: "caller_script_unmatched", detail: callerGap });
  }
  result.toolAssertionsSkipped = evalResult.skipped.length > 0;
  result.verdict = result.failures.length === 0 ? "PASS" : "FAIL";
  return result;
}

// ---- CLI options ----

export interface CliOptions {
  only: string | null;
  repeat: number;
}

// --only <scenario id> and --repeat <n> (default 1); usage errors name the
// problem, and an unknown id lists the valid ids.
export function parseCliArgs(
  argv: string[],
  validIds: string[],
): CliOptions | { error: string } {
  let only: string | null = null;
  let repeat = 1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const id = argv[i + 1];
      if (id === undefined) return { error: "--only needs a scenario id" };
      if (!validIds.includes(id)) {
        return {
          error: `unknown scenario id "${id}"; valid ids: ${validIds.join(", ")}`,
        };
      }
      only = id;
      i += 1;
    } else if (arg === "--repeat") {
      const n = argv[i + 1];
      if (n === undefined || !/^\d+$/.test(n) || Number(n) < 1) {
        return { error: "--repeat needs a positive integer" };
      }
      repeat = Number(n);
      i += 1;
    } else {
      return { error: `unknown option "${arg}"` };
    }
  }
  return { only, repeat };
}

// ---- repeat aggregation ----

export type RunVerdict = "PASS" | "FAIL" | "ERROR";

// A scenario passes only if every repeat passes.
export function aggregateRuns(verdicts: RunVerdict[]): {
  passed: number;
  verdict: RunVerdict;
} {
  const passed = verdicts.filter((v) => v === "PASS").length;
  const verdict: RunVerdict =
    passed === verdicts.length
      ? "PASS"
      : verdicts.includes("ERROR")
        ? "ERROR"
        : "FAIL";
  return { passed, verdict };
}
