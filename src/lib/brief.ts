// src/lib/brief.ts
// Technician brief for the ring (D20): a pure template, no LLM. Job fields are
// data, never instructions: control characters stripped, length-capped. Plain
// text only (no SSML / tags), so nothing here can steer the speech model.
// D20b-2: the spoken brief names only the urgency, trade, suburb and address
// — never the reference, the customer name or any phone number; those go by
// SMS after the technician accepts (the brief never mentions the SMS).

export const BRIEF_MAX_LEN = 1000;
export const SUMMARY_MAX_LEN = 200;

// The dispatch business name, shared with /dv so it is written once.
export const BUSINESS_NAME = "Harbour Trades After-Hours";

export interface BriefJob {
  job_id: string;
  urgency: string;
  trade: string;
  suburb: string;
  address?: string;
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

// Fixed closing is appended after every variable field, which is capped at the
// source, so it always fits inside BRIEF_MAX_LEN untruncated. Missing fields
// drop their fragment cleanly (no "undefined", no double commas).
// D20b-3: the stored urgency is spoken as-is, first letter capitalised (no
// mapping); an empty one is omitted.
export function buildBrief(job: BriefJob): string {
  const urgency = field(job.urgency);
  const head = urgency === "" ? "" : urgency.charAt(0).toUpperCase() + urgency.slice(1);
  const trade = field(job.trade);
  const suburb = field(job.suburb);
  const address = job.address === undefined ? "" : field(job.address);
  const jobPart = trade === "" ? "job" : `${trade} job`;
  let tail = "";
  if (suburb !== "" && address !== "") tail = ` in ${suburb}, ${address}`;
  else if (suburb !== "") tail = ` in ${suburb}`;
  else if (address !== "") tail = ` ${address}`;
  const body = head === "" ? jobPart.charAt(0).toUpperCase() + jobPart.slice(1) : `${head} ${jobPart}`;
  return `Hi, ${BUSINESS_NAME} dispatch. ${body}${tail}. Press 1 to accept, or 2 to decline.`;
}
