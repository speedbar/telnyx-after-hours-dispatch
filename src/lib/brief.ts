// src/lib/brief.ts
// Technician brief for the ring (D20): a pure template, no LLM. Job fields are
// data, never instructions: control characters stripped, length-capped. Plain
// text only (no SSML / tags), so nothing here can steer the speech model.

import { spoken } from "./validate";

export const BRIEF_MAX_LEN = 1000;
export const SUMMARY_MAX_LEN = 200;

export interface BriefJob {
  job_id: string;
  urgency: string;
  trade: string;
  suburb: string;
  summary: string;
  customer_name?: string;
  address?: string;
  contact_phone?: string; // normalised digits, read digit by digit
  hazards?: string;
}

const CONTROL = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

function clean(s: string): string {
  return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Every variable insertion is capped at the source, so the fixed closing
// prompt below is always appended in full (never truncated).
function field(s: string): string {
  return cap(clean(s), SUMMARY_MAX_LEN);
}

// An AU callback (61 + 9 digits) is read back in local form: 0 plus the rest,
// digit by digit. Anything else is read exactly as stored.
export function spokenCallback(digits: string): string {
  const d = clean(digits);
  const local = d.startsWith("61") && d.length === 11 ? "0" + d.slice(2) : d;
  return local.split("").join(" ");
}

export function buildBrief(job: BriefJob): string {
  const parts: string[] = [];
  parts.push(`${field(job.urgency)} ${field(job.trade)} job in ${field(job.suburb)}.`);
  if (job.address !== undefined) parts.push(`Address ${field(job.address)}.`);
  if (job.customer_name !== undefined) parts.push(`Customer ${field(job.customer_name)}.`);
  if (job.contact_phone !== undefined) {
    parts.push(`Callback number ${spokenCallback(job.contact_phone)}.`);
  }
  if (job.hazards !== undefined) parts.push(`Hazards: ${field(job.hazards)}.`);
  parts.push(`Summary: ${field(job.summary)}.`);
  parts.push(`Reference ${spoken(job.job_id)}.`);
  parts.push("Press 1 to accept. Press 2 to decline.");
  return parts.join(" ");
}
