// src/tools/index.ts
// Tool registry for the MCP route: name, description, JSON Schema, handler.
// Handlers are plain functions over actor namespaces (ToolEnv) so they test
// with the real actor classes on fake storage — no MCP protocol, no network.
// A missing namespace throws; the route turns that into an internal error.

import { handleCreateJob } from "./create_job";
import { handleLookupCustomer } from "./lookup_customer";
import { handleReleaseTechnician } from "./release_technician";
import { handleReserveTechnician } from "./reserve_technician";

export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

// Small structural stub interfaces (like SeedStub in src/routes/seed.ts);
// the real actor classes satisfy them.
export interface DirectoryStub {
  lookup(
    phoneDigits: string,
    flagName: string,
  ): Promise<{ flag: string | null; customer: string | null }>;
  flag(name: string): Promise<string | null>;
}

export interface TechStub {
  reserve(args: {
    call_ref: string;
    job_id: string;
    ttl_s?: number;
  }): Promise<{ ok: true; expires_at: number } | { ok: false; reason: string }>;
  release(args: { call_ref: string; job_id: string }): Promise<{ released: boolean }>;
  status(): Promise<{
    status: string;
    held_for?: { call_ref: string; job_id: string; expires_at: number };
  }>;
}

export interface JobStub {
  open(args: {
    job_id: string;
    tech_id: string;
    urgency: string;
    trade: string;
    suburb: string;
    summary: string;
  }): Promise<
    { ok: true; state: string; created: boolean } | { ok: false; reason: string }
  >;
  brief(args: {
    job_id: string;
    customer_name: string;
    address: string;
    contact_phone?: string;
    details: string;
    hazards?: string;
  }): Promise<{ ok: true; state: string } | { ok: false; reason: string }>;
  release(args: { job_id: string; reason: string }): Promise<{ released: boolean }>;
  get(): Promise<{
    job_id: string;
    tech_id: string;
    state: "reserved" | "briefed" | "released";
  } | null>;
}

export interface ToolEnv {
  DIRECTORY?: { idFromName(name: string): DirectoryStub };
  TECH?: { idFromName(name: string): TechStub };
  JOBS?: { idFromName(name: string): JobStub };
  [key: string]: unknown;
}

export type ToolHandler = (args: unknown, env: ToolEnv) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "lookup_customer",
    description:
      "Look up the caller's phone number in the customer directory. Call this early to personalise the greeting and confirm the service address.",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", maxLength: 32 },
      },
      required: ["phone"],
      additionalProperties: false,
    },
    handler: handleLookupCustomer,
  },
  {
    name: "reserve_technician",
    description:
      "Reserve an on-call technician for this emergency call. Call this as soon as the problem is classified; it places a short hold so the same technician cannot be given to another caller.",
    inputSchema: {
      type: "object",
      properties: {
        call_ref: { type: "string", maxLength: 128 },
        urgency: { type: "string", enum: ["emergency", "urgent"] },
        trade: {
          type: "string",
          enum: ["plumbing", "electrical", "gas", "hvac", "other"],
        },
        suburb: { type: "string", maxLength: 60 },
        summary: { type: "string", maxLength: 200 },
      },
      required: ["call_ref", "urgency", "trade", "suburb", "summary"],
      additionalProperties: false,
    },
    handler: handleReserveTechnician,
  },
  {
    name: "create_job",
    description:
      "Save the caller's details onto the reserved job and get a spoken job reference. Call this after a technician is reserved and the caller has confirmed their details.",
    inputSchema: {
      type: "object",
      properties: {
        call_ref: { type: "string", maxLength: 128 },
        job_id: { type: "string", maxLength: 6 },
        customer_name: { type: "string", maxLength: 80 },
        address: { type: "string", maxLength: 200 },
        contact_phone: { type: "string", maxLength: 32 },
        details: { type: "string", maxLength: 500 },
        hazards: { type: "string", maxLength: 200 },
      },
      required: ["call_ref", "job_id", "customer_name", "address", "details"],
      additionalProperties: false,
    },
    handler: handleCreateJob,
  },
  {
    name: "release_technician",
    description:
      "Cancel the technician hold for this call, for example when the technician declines or does not answer. Safe to call more than once.",
    inputSchema: {
      type: "object",
      properties: {
        call_ref: { type: "string", maxLength: 128 },
        job_id: { type: "string", maxLength: 6 },
        reason: {
          type: "string",
          enum: ["declined", "no_answer", "caller_hung_up", "error"],
        },
      },
      required: ["call_ref", "job_id", "reason"],
      additionalProperties: false,
    },
    handler: handleReleaseTechnician,
  },
];
