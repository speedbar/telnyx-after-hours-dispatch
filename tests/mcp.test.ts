// tests/mcp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcp, type McpEnv } from "../src/routes/mcp.js";
import type { ToolDefinition } from "../src/tools/index.js";

const TOKEN = "mcp-token-for-tests-0123456789";

// Fake registry: one ok tool, one business failure, one that throws.
const REGISTRY: ToolDefinition[] = [
  {
    name: "ok_tool",
    description: "returns ok",
    inputSchema: { type: "object" },
    handler: async () => ({ ok: true, note: "done" }),
  },
  {
    name: "bad_tool",
    description: "business failure",
    inputSchema: { type: "object" },
    handler: async () => ({ ok: false, reason: "x" }),
  },
  {
    name: "boom_tool",
    description: "throws",
    inputSchema: { type: "object" },
    handler: async () => {
      throw new TypeError("boom secret payload");
    },
  },
];

const env: McpEnv = { MCP_TOKEN: TOKEN };

function mcpRequest(
  body?: string,
  opts: { token?: string; via?: "bearer" | "x-api-key"; method?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) {
    if (opts.via === "x-api-key") {
      headers["x-api-key"] = opts.token;
    } else {
      headers.authorization = `Bearer ${opts.token}`;
    }
  }
  return new Request("https://test.invalid/mcp", {
    method: opts.method ?? "POST",
    body,
    headers,
  });
}

function rpc(method: string, params?: unknown, id: unknown = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: unknown) => {
    lines.push(String(msg));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("1. GET: 405 with Allow: POST header, no log line", async () => {
  const cap = captureLog();
  try {
    const res = await handleMcp(mcpRequest(undefined, { token: TOKEN, method: "GET" }), env, REGISTRY);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
    assert.deepEqual(await res.json(), { ok: false, error: "method_not_allowed" });
    assert.equal(cap.lines.length, 0);
  } finally {
    cap.restore();
  }
});

test("2. auth failures: 401 + matching logged reason, never the token", async () => {
  const cap = captureLog();
  try {
    const wrong = TOKEN.slice(0, -1) + "x";
    let res = await handleMcp(mcpRequest(rpc("ping"), { token: TOKEN }), {}, REGISTRY);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });

    res = await handleMcp(mcpRequest(rpc("ping")), env, REGISTRY);
    assert.equal(res.status, 401);

    res = await handleMcp(mcpRequest(rpc("ping"), { token: wrong }), env, REGISTRY);
    assert.equal(res.status, 401);

    const logs = parsed(cap.lines).filter((l) => l.event === "auth_fail");
    assert.deepEqual(
      logs.map((l) => l.error),
      ["no_token_configured", "no_auth_header", "bad_token"],
    );
    assert.ok(
      logs.every(
        (l) => l.level === "warn" && l.outcome === "rejected" && l.component === "mcp",
      ),
    );
    const joined = cap.lines.join("\n");
    assert.ok(!joined.includes(TOKEN), "no log line may contain the token");
    assert.ok(!joined.includes(wrong), "no log line may contain the presented token");
  } finally {
    cap.restore();
  }
});

test("3. both Authorization: Bearer and x-api-key are accepted", async () => {
  const cap = captureLog();
  try {
    for (const via of ["bearer", "x-api-key"] as const) {
      const res = await handleMcp(mcpRequest(rpc("ping"), { token: TOKEN, via }), env, REGISTRY);
      assert.equal(res.status, 200, via);
      const body = await res.json();
      assert.deepEqual(body, { jsonrpc: "2.0", id: 1, result: {} });
    }
  } finally {
    cap.restore();
  }
});

test("4. invalid JSON -> -32700; batch array and bad envelopes -> -32600", async () => {
  const cap = captureLog();
  try {
    let res = await handleMcp(mcpRequest("{nope", { token: TOKEN }), env, REGISTRY);
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.equal(body.error.code, -32700);
    assert.equal(body.id, null);

    const bads = [
      JSON.stringify([JSON.parse(rpc("ping"))]),
      JSON.stringify("hello"),
      JSON.stringify({ id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    ];
    for (const bad of bads) {
      res = await handleMcp(mcpRequest(bad, { token: TOKEN }), env, REGISTRY);
      assert.equal(res.status, 400, bad);
      body = await res.json();
      assert.equal(body.error.code, -32600, bad);
    }
  } finally {
    cap.restore();
  }
});

test("5. notification (no id) -> 202 with empty body", async () => {
  const cap = captureLog();
  try {
    for (const method of ["notifications/initialized", "nope"]) {
      const note = JSON.stringify({ jsonrpc: "2.0", method });
      const res = await handleMcp(mcpRequest(note, { token: TOKEN }), env, REGISTRY);
      assert.equal(res.status, 202, method);
      assert.equal(await res.text(), "");
    }
    assert.equal(cap.lines.length, 0);
  } finally {
    cap.restore();
  }
});

test("6. initialize echoes the protocolVersion and has serverInfo/capabilities", async () => {
  const cap = captureLog();
  try {
    const res = await handleMcp(
      mcpRequest(rpc("initialize", { protocolVersion: "2024-11-05" }), { token: TOKEN }),
      env,
      REGISTRY,
    );
    const body = await res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, "2024-11-05");
    assert.deepEqual(body.result.capabilities, { tools: {} });
    assert.deepEqual(body.result.serverInfo, {
      name: "dispatch-mcp",
      version: "0.1.0",
    });

    const res2 = await handleMcp(
      mcpRequest(rpc("initialize", { protocolVersion: 42 }), { token: TOKEN }),
      env,
      REGISTRY,
    );
    const body2 = await res2.json();
    assert.equal(body2.result.protocolVersion, "2025-03-26");
  } finally {
    cap.restore();
  }
});

test("7. tools/list lists the registry names with inputSchema", async () => {
  const cap = captureLog();
  try {
    const res = await handleMcp(mcpRequest(rpc("tools/list"), { token: TOKEN }), env, REGISTRY);
    const body = await res.json();
    assert.deepEqual(
      body.result.tools.map((t: { name: string }) => t.name),
      ["ok_tool", "bad_tool", "boom_tool"],
    );
    assert.ok(
      body.result.tools.every(
        (t: { description: unknown; inputSchema: unknown }) =>
          typeof t.description === "string" &&
          typeof t.inputSchema === "object" &&
          t.inputSchema !== null,
      ),
    );
  } finally {
    cap.restore();
  }
});

test("8. tools/call shapes: success, business failure and throw; mcp_call logs", async () => {
  const cap = captureLog();
  try {
    let res = await handleMcp(
      mcpRequest(
        rpc("tools/call", { name: "ok_tool", arguments: { call_ref: "cr-1", secret_arg: "value123" } }),
        { token: TOKEN },
      ),
      env,
      REGISTRY,
    );
    let body = await res.json();
    assert.equal(body.result.isError, false);
    assert.deepEqual(JSON.parse(body.result.content[0].text), { ok: true, note: "done" });

    res = await handleMcp(mcpRequest(rpc("tools/call", { name: "bad_tool" }), { token: TOKEN }), env, REGISTRY);
    body = await res.json();
    assert.equal(body.result.isError, false);
    assert.deepEqual(JSON.parse(body.result.content[0].text), { ok: false, reason: "x" });

    res = await handleMcp(mcpRequest(rpc("tools/call", { name: "boom_tool" }), { token: TOKEN }), env, REGISTRY);
    body = await res.json();
    assert.equal(body.result.isError, true);
    assert.deepEqual(JSON.parse(body.result.content[0].text), { ok: false, error: "internal" });
    assert.ok(!JSON.stringify(body).includes("boom"), "no exception message in the response");

    const logs = parsed(cap.lines).filter((l) => l.event === "mcp_call");
    assert.equal(logs.length, 3);
    assert.deepEqual(
      logs.map((l) => l.tool),
      ["ok_tool", "bad_tool", "boom_tool"],
    );
    assert.deepEqual(
      logs.map((l) => l.outcome),
      ["ok", "rejected", "fail"],
    );
    assert.ok(logs.every((l) => typeof l.latency_ms === "number"));
    // The raw model call_ref is never logged; the resolved safe "c:" ref is.
    assert.match(String(logs[0].call_ref), /^c:[0-9a-f]{32}$/);
    assert.equal(logs[0].call_ref_source, "args");
    assert.equal(logs[1].call_ref, null);
    assert.equal(logs[1].call_ref_source, "none");
    assert.equal(logs[1].error, "x");
    assert.equal(logs[2].error, "TypeError");
    const joined = cap.lines.join("\n");
    assert.ok(!joined.includes("cr-1"), "no raw call_ref in the logs");
    assert.ok(!joined.includes("value123"), "no argument values in the logs");
    assert.ok(!joined.includes("boom secret payload"));
  } finally {
    cap.restore();
  }
});

test("11. tools/call: _meta conversation id wins, meta key names logged (never values), ctx reaches the handler", async () => {
  const cap = captureLog();
  const seen: unknown[] = [];
  const registry: ToolDefinition[] = [
    {
      name: "ctx_tool",
      description: "captures ctx and returns bad_fields",
      inputSchema: { type: "object" },
      handler: async (_args, _env, ctx) => {
        seen.push(ctx);
        return { ok: false, reason: "invalid_input", bad_fields: ["phone", "address"] };
      },
    },
  ];
  try {
    let res = await handleMcp(
      mcpRequest(
        rpc("tools/call", {
          name: "ctx_tool",
          arguments: { call_ref: "model-sent-ref" },
          _meta: { telnyx_conversation_id: "conv-9z8y7x", other_stuff: "shh" },
        }),
        { token: TOKEN },
      ),
      env,
      registry,
    );
    let body = await res.json();
    assert.equal(body.result.isError, false);

    // Fallback key name also accepted.
    res = await handleMcp(
      mcpRequest(
        rpc("tools/call", {
          name: "ctx_tool",
          arguments: {},
          _meta: { conversation_id: "alt-conv-id" },
        }),
        { token: TOKEN },
      ),
      env,
      registry,
    );
    body = await res.json();

    assert.deepEqual(seen, [
      { meta_conversation_id: "conv-9z8y7x" },
      { meta_conversation_id: "alt-conv-id" },
    ]);

    const logs = parsed(cap.lines).filter((l) => l.event === "mcp_call");
    assert.equal(logs.length, 2);
    assert.match(String(logs[0].call_ref), /^c:[0-9a-f]{32}$/);
    assert.equal(logs[0].call_ref_source, "meta");
    assert.equal(logs[0].meta_keys, "telnyx_conversation_id,other_stuff");
    assert.equal(logs[0].bad_fields, "phone,address");
    assert.equal(logs[1].call_ref_source, "meta");
    assert.equal(logs[1].meta_keys, "conversation_id");
    const joined = cap.lines.join("\n");
    for (const forbidden of ["conv-9z8y7x", "alt-conv-id", "shh", "model-sent-ref"]) {
      assert.ok(!joined.includes(forbidden), `no _meta or argument values in the logs: ${forbidden}`);
    }
  } finally {
    cap.restore();
  }
});

test("9. unknown tool -> -32602 unknown_tool; unknown method -> -32601", async () => {
  const cap = captureLog();
  try {
    let res = await handleMcp(
      mcpRequest(rpc("tools/call", { name: "nope" }), { token: TOKEN }),
      env,
      REGISTRY,
    );
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.error.code, -32602);
    assert.equal(body.error.message, "unknown_tool");

    res = await handleMcp(mcpRequest(rpc("tools/nope"), { token: TOKEN }), env, REGISTRY);
    body = await res.json();
    assert.equal(body.error.code, -32601);
  } finally {
    cap.restore();
  }
});

test("10. body over 32768 characters -> 413 too_large", async () => {
  const cap = captureLog();
  try {
    const big = rpc("ping") + " ".repeat(32768);
    const res = await handleMcp(mcpRequest(big, { token: TOKEN }), env, REGISTRY);
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { ok: false, error: "too_large" });
  } finally {
    cap.restore();
  }
});
