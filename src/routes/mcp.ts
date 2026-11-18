// src/routes/mcp.ts
// POST /mcp — stateless JSON-RPC over HTTP for the assistant's tools (MCP).
// One message per POST, plain JSON responses, no streaming. Auth accepts the
// key as "Authorization: Bearer <token>" or "x-api-key: <token>", compared in
// constant time against the MCP_TOKEN secret (tokenEqual from ./seed).
// Never logs tokens, header values, arguments, names or phone numbers.

import { readConfig } from "../lib/config";
import { log, newRequestId, timed, type LogFields } from "../lib/log";
import { isCallRef } from "../lib/validate";
import {
  TOOLS,
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

  const { result: run, latency_ms } = await timed(
    async (): Promise<RunOutcome> => {
      try {
        return { threw: false, output: await tool.handler(args, env) };
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
  };
  // call_ref is the only argument piece that may be logged (charset-checked).
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const callRef = (args as Record<string, unknown>).call_ref;
    if (isCallRef(callRef)) {
      fields.call_ref = callRef;
    }
  }

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
