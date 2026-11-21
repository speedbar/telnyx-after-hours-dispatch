import { readConfig } from "./lib/config";
import { handleDv } from "./routes/dv";
import { handleMcp } from "./routes/mcp";
import { handleSeed } from "./routes/seed";
import { handleTech } from "./routes/tech";
import { handleRingTest } from "./routes/ringtest";
import { handleJobState } from "./routes/jobstate";
import { handleRingStart } from "./routes/ringstart";
import { handleVoiceEvents } from "./routes/voice";

// Re-export the actor classes from the entry point so they are bundled and
// shipped with the function (the runtime resolves each [[actors]] type here;
// the exported class name must equal the type).
export { TechnicianActor } from "./actors/TechnicianActor";
export { DirectoryActor } from "./actors/DirectoryActor";
export { JobActor } from "./actors/JobActor";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        // Booleans only — never the secret values.
        secrets: {
          TELNYX_PUBLIC_KEY: readConfig(env, "TELNYX_PUBLIC_KEY") !== undefined,
          LOG_SALT: readConfig(env, "LOG_SALT") !== undefined,
          MCP_TOKEN: readConfig(env, "MCP_TOKEN") !== undefined,
          FALLBACK_NUMBER: readConfig(env, "FALLBACK_NUMBER") !== undefined,
          // D20 ring secrets (presence booleans only, never values).
          TELNYX_API_KEY: readConfig(env, "TELNYX_API_KEY") !== undefined,
          VOICE_CONNECTION_ID: readConfig(env, "VOICE_CONNECTION_ID") !== undefined,
          DISPATCH_FROM_NUMBER: readConfig(env, "DISPATCH_FROM_NUMBER") !== undefined,
          TECH_PHONES_JSON: readConfig(env, "TECH_PHONES_JSON") !== undefined,
        },
      });
    }
    if (url.pathname === "/dv") {
      // Spread: the generated Env is an interface with no implicit index
      // signature, so it is not assignable to DvEnv as-is, and casting would
      // hide that. The spread keeps the real bindings/secrets by reference.
      return await handleDv(req, { ...env });
    }
    if (url.pathname === "/mcp") {
      // Same spread pattern as /dv. Token check happens inside handleMcp.
      return await handleMcp(req, { ...env });
    }
    if (url.pathname === "/admin/seed") {
      // Same spread pattern as /dv. Token check happens inside handleSeed.
      return await handleSeed(req, { ...env });
    }
    if (url.pathname === "/admin/tech") {
      // Same spread pattern as /admin/seed. Token check inside handleTech.
      return await handleTech(req, { ...env });
    }
    if (url.pathname === "/admin/ring-test") {
      // Same spread pattern as /admin/tech. Token check inside handleRingTest.
      return await handleRingTest(req, { ...env });
    }
    if (url.pathname === "/admin/job-state") {
      // Same spread pattern as /admin/tech. Token check inside handleJobState.
      return await handleJobState(req, { ...env });
    }
    if (url.pathname === "/ring-start") {
      // Same spread pattern as /admin/tech. The single-use token check runs
      // inside consumeRingToken; there is no header auth on this route.
      return await handleRingStart(req, { ...env });
    }
    if (url.pathname === "/voice-events") {
      // Same spread pattern as /dv. Signature check happens inside.
      return await handleVoiceEvents(req, { ...env });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  },
};
