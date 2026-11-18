// scripts/concurrency.ts
// Proves the one-technician-one-hold rule against a LIVE deployment: fires 6
// parallel reserve calls at tech-01 via POST /admin/tech and expects exactly
// one ok and five busy. Plain Node, built-ins only.
// Run: ADMIN_TOKEN=... npx tsx scripts/concurrency.ts <base-url>
// The token is read from the environment and never printed.

import { randomUUID } from "node:crypto";

interface TechResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ReserveArgs {
  call_ref: string;
  job_id: string;
  ttl_s: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function write(line: string): void {
  process.stdout.write(line + "\n");
}

// One POST /admin/tech call; throws on a non-200 HTTP status.
async function callTech(
  base: string,
  token: string,
  method: string,
  args?: unknown,
): Promise<TechResponse> {
  const res = await fetch(`${base}/admin/tech`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({ tech_id: "tech-01", method, args }),
  });
  if (!res.ok) {
    throw new Error(`http_${res.status}`);
  }
  return (await res.json()) as TechResponse;
}

async function main(): Promise<number> {
  const token = process.env.ADMIN_TOKEN;
  if (token === undefined || token === "") {
    write("ADMIN_TOKEN is not set; export it first (never paste it here)");
    return 1;
  }
  const base = process.argv[2];
  if (base === undefined || base === "") {
    write("usage: npx tsx scripts/concurrency.ts <base-url>");
    return 1;
  }

  // Clear any leftover hold from an earlier run.
  await callTech(base, token, "setShift", false);
  await callTech(base, token, "setShift", true);

  const jobs = Array.from({ length: 6 }, () => ({
    call_ref: `sim-${randomUUID()}`,
    job_id: `job-${randomUUID()}`,
    ttl_s: 5,
  }));
  const results = await Promise.all(
    jobs.map(async (args: ReserveArgs) => {
      try {
        return { args, body: await callTech(base, token, "reserve", args) };
      } catch {
        return { args, body: null };
      }
    }),
  );

  let ok = 0;
  let busy = 0;
  let other = 0;
  let winner: ReserveArgs | null = null;
  for (const r of results) {
    const result = r.body?.result;
    if (r.body?.ok === true && isRecord(result) && result.ok === true) {
      ok += 1;
      winner = r.args;
    } else if (isRecord(result) && result.ok === false && result.reason === "busy") {
      busy += 1;
    } else {
      other += 1;
    }
  }
  write(`ok=${ok} busy=${busy} other=${other}`);

  if (winner !== null) {
    try {
      const rel = await callTech(base, token, "release", {
        call_ref: winner.call_ref,
        job_id: winner.job_id,
      });
      write(`release ${JSON.stringify(rel.result ?? null)}`);
    } catch (err) {
      write(`release error ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  try {
    const st = await callTech(base, token, "status");
    write(`status ${JSON.stringify(st.result ?? null)}`);
  } catch (err) {
    write(`status error ${err instanceof Error ? err.message : "unknown"}`);
  }

  return ok === 1 && busy === 5 ? 0 : 1;
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
