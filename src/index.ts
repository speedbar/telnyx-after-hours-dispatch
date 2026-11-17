// Re-export the actor class from the entry point so it is bundled and shipped
// with the function (the runtime resolves the [[actors]] type here; the
// exported class name must equal the type).
export { TechnicianActor } from "./actors/TechnicianActor";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    // TEMPORARY, unauthenticated test routes from S0.3; remove or protect before the demo.
    if (url.pathname === "/kv-test" || url.pathname === "/actor-test") {
      if (req.method !== "POST") {
        return Response.json(
          { ok: false, error: "method_not_allowed" },
          { status: 405 },
        );
      }
      if (url.pathname === "/kv-test") {
        try {
          const key = "kvtest/ping";
          await env.DISPATCH_KV.put(key, new Date().toISOString(), {
            expirationTtl: 30,
          });
          const value = await env.DISPATCH_KV.get(key);
          return Response.json({ ok: true, key, value, ttl_s: 30 });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: "kv_error",
              detail: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          );
        }
      }
      const stub = env.TECH.idFromName("tech-01");
      const result = await stub.ping();
      return Response.json({ ok: true, actor: "tech-01", ...result });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  },
};
