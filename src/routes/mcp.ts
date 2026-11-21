// src/routes/mcp.ts
// POST /mcp — stateless JSON-RPC over HTTP for the assistant's tools (MCP).
// One message per POST, plain JSON responses, no streaming. Auth accepts the
// key as "Authorization: Bearer <token>" or "x-api-key: <token>", compared in
// constant time against the MCP_TOKEN secret (tokenEqual from ./seed).
// Never logs tokens, header values, arguments, names or phone numbers.

import { readConfig } from "../lib/config";
import {
  bootFields,
  callerHash,
  log,
  newRequestId,
  setToolLogCtx,
  timed,
  toolLogCtxOf,
  type LogFields,
} from "../lib/log";
import { resolveCallRef } from "../lib/validate";
import {
  TOOLS,
  type ToolCtx,
  type ToolDefinition,
  type ToolEnv,
  type ToolResult,
} from "../tools/index";
import { tokenEqual } from "./seed";

export type McpEnv = ToolEnv & { [key: string]: unknown };

const MAX_BODY_CHARS = 32768;

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { status: 200 });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } },
    { status },
  );
}

// The presented key from either header, or null. Bearer wins. Never logged.
function presentedToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth !== null && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7);
  }
  return request.headers.get("x-api-key");
}

export async function handleMcp(
  request: Request,
  env: McpEnv,
  registry: ToolDefinition[] = TOOLS,
): Promise<Response> {
  const request_id = newRequestId();

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const expected = readConfig(env, "MCP_TOKEN");
  const presented = presentedToken(request);
  if (expected === undefined || presented === null || !tokenEqual(presented, expected)) {
    const error =
      expected === undefined
        ? "no_token_configured"
        : presented === null
          ? "no_auth_header"
          : "bad_token";
    log({
      component: "mcp",
      event: "auth_fail",
      level: "warn",
      outcome: "rejected",
      request_id,
      error,
    });
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return Response.json({ ok: false, error: "too_large" }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "parse_error", 400);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return rpcError(null, -32600, "invalid_request", 400);
  }
  const msg = raw as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(null, -32600, "invalid_request", 400);
  }

  // A message with no id is a notification: accepted, never answered.
  if (msg.id === undefined) {
    return new Response(null, { status: 202 });
  }
  const id = msg.id;
  const params =
    msg.params !== null && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};

  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "dispatch-mcp", version: "0.1.0" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: registry.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call":
      return handleToolCall(id, params, env, registry, request_id);
    default:
      return rpcError(id, -32601, "method_not_found");
  }
}

type RunOutcome =
  | { threw: false; output: ToolResult }
  | { threw: true; errName: string };

// S1.9: numeric hop timings a tool stashed on its ctx are copied onto the
// mcp_call line. Numbers only, never argument values.
const HOP_KEYS = [
  "hop_flag_ms",
  "hop_job_get_ms",
  "hop_tech_ms",
  "hop_job_open_ms",
  "hop_tech_status_ms",
  "hop_brief_ms",
  "hop_mark_booked_ms",
  "hop_job_write_ms",
  "hop_ring_ms",
] as const;

// tools/call: dispatch to the registry handler and log one mcp_call line
// whatever the outcome. The handler runs inside timed() (src/lib/log.ts).
async function handleToolCall(
  id: unknown,
  params: Record<string, unknown>,
  env: McpEnv,
  registry: ToolDefinition[],
  request_id: string,
): Promise<Response> {
  const name = params.name;
  const tool =
    typeof name === "string" ? registry.find((t) => t.name === name) : undefined;
  if (tool === undefined) {
    return rpcError(id, -32602, "unknown_tool");
  }
  const args = params.arguments === undefined ? {} : params.arguments;

  // Server-side call identity: the conversation id comes from _meta (key name
  // VERIFY, see docs/verify-log.md V-016), never from the model. Only key
  // names of _meta are logged, never values.
  const meta =
    params._meta !== null &&
    typeof params._meta === "object" &&
    !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : undefined;
  const ctx: ToolCtx = {};
  if (meta !== undefined) {
    const telnyxId = meta.telnyx_conversation_id;
    const altId = meta.conversation_id;
    if (typeof telnyxId === "string" && telnyxId !== "") {
      ctx.meta_conversation_id = telnyxId;
    } else if (typeof altId === "string" && altId !== "") {
      ctx.meta_conversation_id = altId;
    }
  }
  // conv_hash (S1.9 item 5d): salted hash of the Telnyx conversation id from
  // _meta, same salt and method as caller_hash, null when there is no id.
  // The raw id is never logged. Handlers read request_id/conv_hash off the
  // tool-call ctx so every line of one tool call shares them (item 5c).
  const salt = readConfig(env, "LOG_SALT");
  const convId = meta?.telnyx_conversation_id;
  const conv_hash =
    typeof convId === "string" && convId !== "" && salt !== undefined
      ? await callerHash(convId, salt)
      : undefined;
  setToolLogCtx(ctx, {
    request_id,
    ...(conv_hash !== undefined ? { conv_hash } : {}),
  });

  // Resolved once here for the log line; handlers resolve the same value
  // (deterministic hash). The safe "c:" ref is logged even for rejected calls.
  const resolved = await resolveCallRef(args, ctx);

  const { result: run, latency_ms } = await timed(
    async (): Promise<RunOutcome> => {
      try {
        return { threw: false, output: await tool.handler(args, env, ctx) };
      } catch (err) {
        return { threw: true, errName: err instanceof Error ? err.name : "unknown" };
      }
    },
  );

  const fields: LogFields = {
    component: "mcp",
    event: "mcp_call",
    tool: tool.name,
    request_id,
    latency_ms,
    call_ref: resolved.ref ?? undefined,
    call_ref_source: resolved.source,
    meta_keys: meta === undefined ? undefined : Object.keys(meta).join(","),
  };
  const tlc = toolLogCtxOf(ctx);
  for (const key of HOP_KEYS) {
    const v = tlc[key];
    if (typeof v === "number") fields[key] = v;
  }
  // The technician the tool reserved (or the job's technician): id only.
  if (typeof tlc.technician_id === "string") fields.technician_id = tlc.technician_id;
  if (conv_hash !== undefined) fields.conv_hash = conv_hash;
  // S1.9b diagnostics: flag source, pool size and instance boot facts.
  if (typeof tlc.flag_source === "string") fields.flag_source = tlc.flag_source;
  if (typeof tlc.eligible_count === "number") fields.eligible_count = tlc.eligible_count;
  const boot = bootFields();
  fields.boot_age_ms = boot.boot_age_ms;
  fields.first_request = boot.first_request;

  if (run.threw) {
    fields.outcome = "fail";
    fields.error = run.errName;
    if (latency_ms > 500) {
      fields.level = "warn";
    }
    log(fields);
    return rpcResult(id, {
      content: [
        { type: "text", text: JSON.stringify({ ok: false, error: "internal" }) },
      ],
      isError: true,
    });
  }

  const output = run.output;
  fields.outcome = output.ok ? "ok" : "rejected";
  if (!output.ok && typeof output.reason === "string") {
    fields.error = output.reason;
  }
  if (
    Array.isArray(output.bad_fields) &&
    output.bad_fields.every((f) => typeof f === "string")
  ) {
    fields.bad_fields = (output.bad_fields as string[]).join(",");
  }
  if (typeof output.job_id === "string") {
    fields.job_id = output.job_id;
  }
  if (latency_ms > 500) {
    fields.level = "warn";
    if (fields.error === undefined) {
      fields.error = "over_budget";
    }
  }
  log(fields);
  return rpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(output) }],
    isError: false,
  });
}
