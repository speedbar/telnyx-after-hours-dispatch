// src/tools/lookup_customer.ts
// Find the customer record for a caller's phone number (mocked business
// data behind the DirectoryActor). Unknown input -> invalid_input; anything
// unusable in the record -> found:false. Business failures as data.

import { cleanText, normalisePhone } from "../lib/validate";
import type { ToolCtx, ToolEnv, ToolResult } from "./index";

export async function handleLookupCustomer(
  args: unknown,
  env: ToolEnv,
  _ctx: ToolCtx,
): Promise<ToolResult> {
  const dir = env.DIRECTORY;
  if (dir === undefined) throw new Error("directory_namespace_missing");
  const digits = normalisePhone((args as Record<string, unknown> | null)?.phone);
  if (digits === null) {
    return {
      ok: false,
      reason: "invalid_input",
      next: "fallback",
      retry: false,
      bad_fields: ["phone"],
    };
  }

  const res = await dir
    .idFromName("directory")
    .lookup(digits, "dispatch_enabled");
  if (res.customer === null) return { ok: true, found: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.customer);
  } catch {
    return { ok: true, found: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: true, found: false };
  }
  const rec = parsed as Record<string, unknown>;
  const name = cleanText(rec.name, 80);
  const address = cleanText(rec.address, 200);
  if (name === null || address === null) return { ok: true, found: false };
  const site_notes =
    rec.site_notes === undefined
      ? undefined
      : (cleanText(rec.site_notes, 200) ?? undefined);
  return {
    ok: true,
    found: true,
    name,
    address,
    ...(site_notes === undefined ? {} : { site_notes }),
    after_hours_contract: rec.after_hours_contract === true,
  };
}
