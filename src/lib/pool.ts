// src/lib/pool.ts
// Mock business data; the README says the business systems are mocked.
export const TECH_POOL = ["tech-01", "tech-02"] as const;
export const TECH_NAMES: Record<(typeof TECH_POOL)[number], string> = {
  "tech-01": "Jordan",
  "tech-02": "Casey",
};
export const ETA_MINUTES = 30;
