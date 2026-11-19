// src/lib/pool.ts
// Mock business data; the README says the business systems are mocked.
export type Trade = "plumbing" | "electrical" | "gas" | "hvac" | "other";
export const TECH_POOL = ["tech-01", "tech-02", "tech-03"] as const;
export type TechId = (typeof TECH_POOL)[number];
export const TECH_NAMES: Record<TechId, string> = {
  "tech-01": "Jordan",
  "tech-02": "Casey",
  "tech-03": "Riley",
};
// A trade listed for a technician means skilled AND licensed for it (gas and
// electrical are licensed work in Australia). Suburb/area matching is out of
// scope (documented limitation, D19).
export const TECH_PROFILES: Record<
  TechId,
  { name: string; trades: readonly Trade[] }
> = {
  "tech-01": { name: "Jordan", trades: ["plumbing", "gas"] },
  "tech-02": { name: "Casey", trades: ["electrical", "hvac"] },
  "tech-03": { name: "Riley", trades: ["plumbing", "other"] },
};
export const ETA_MINUTES = 30;
