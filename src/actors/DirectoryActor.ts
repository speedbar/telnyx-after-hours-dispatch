// src/actors/DirectoryActor.ts
// Hot-path read model for /dv (D13, BUG-003): actor storage is ~0.1 s per op,
// KV is ~1.5-1.9 s — over the 1.5 s dynamic-variables timeout. The actor holds
// the same keys KV holds (built with the shared helpers so the names match),
// seeded via seed() from the /admin/seed route. KV stays the durable copy,
// written off the hot path. Keep both methods tiny: no caching, no TTL.

import { StatefulActor } from "@telnyx/edge-runtime";
import { assertValidKey, keys, sanitizeSegment } from "../lib/kv-keys";

export class DirectoryActor extends StatefulActor {
  // One call for the /dv hot path: the feature flag and the customer record,
  // as raw strings (no parsing). phoneDigits is the E.164 number without the
  // "+" (keys.customer strips the plus, so the key matches the KV name).
  async lookup(
    phoneDigits: string,
    flagName: string,
  ): Promise<{ flag: string | null; customer: string | null }> {
    const [flag, customer] = await Promise.all([
      this.ctx.storage.get<string>(keys.flag(flagName)),
      this.ctx.storage.get<string>(keys.customer("+" + phoneDigits)),
    ]);
    return { flag: flag ?? null, customer: customer ?? null };
  }

  // Single-flag read (same key helper and validation as lookup()).
  async flag(name: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(keys.flag(name))) ?? null;
  }

  // D20: per-day counter in actor storage under a UTC-day key (the ring daily
  // cap). One read-modify-write; over cap returns ok:false without writing.
  async bumpCounter(name: string, cap: number): Promise<{ ok: boolean; count: number }> {
    if (typeof name !== "string" || name === "" || !Number.isInteger(cap) || cap < 1) {
      return { ok: false, count: 0 };
    }
    const day = new Date().toISOString().slice(0, 10); // UTC day, dashes only
    const key = "count/" + sanitizeSegment(name) + "/" + day;
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= cap) return { ok: false, count };
    const next = count + 1;
    await this.ctx.storage.put(key, next);
    return { ok: true, count: next };
  }

  // Off-hot-path write used by /admin/seed. Every key is validated BEFORE any
  // write, so a bad key aborts the whole batch and nothing partial is stored.
  async seed(entries: Array<{ key: string; value: string }>): Promise<number> {
    for (const entry of entries) {
      assertValidKey(entry.key);
    }
    for (const entry of entries) {
      await this.ctx.storage.put(entry.key, entry.value);
    }
    return entries.length;
  }
}
