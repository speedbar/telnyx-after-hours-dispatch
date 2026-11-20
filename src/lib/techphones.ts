// src/lib/techphones.ts
// TECH_PHONES_JSON loader (D20): a JSON map {"tech-01":"+61..."}. Every value
// is normalised at load; bad entries collect ids only (never values) so the
// caller can log ring_skip per id. Never throws, never logs.

import { dialableCallback } from "./validate";

export interface TechPhones {
  phones: Record<string, string>; // technician_id -> normalised digits (no plus)
  invalid: string[]; // ids with a missing or undiallable entry
}

export function loadTechPhones(raw: string | undefined): TechPhones {
  const phones: Record<string, string> = {};
  const invalid: string[] = [];
  if (raw === undefined || raw === "") return { phones, invalid };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { phones, invalid };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { phones, invalid };
  }
  for (const [id, value] of Object.entries(parsed)) {
    const digits = dialableCallback(value);
    if (digits === null) invalid.push(id);
    else phones[id] = digits;
  }
  return { phones, invalid };
}
