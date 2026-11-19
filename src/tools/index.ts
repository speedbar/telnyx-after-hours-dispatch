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

// Per-call context resolved by the MCP route from tools/call _meta. The
// conversation id (if Telnyx sends one) outranks any model-sent call_ref.
export interface ToolCtx {
  meta_conversation_id?: string;
}

export type ToolHandler = (
  args: unknown,
  env: ToolEnv,
  ctx: ToolCtx,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const CALL_REF_PROP = {
  type: "string",
  maxLength: 200,
  description: "Optional. Not needed; the server identifies the call itself.",
} as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: "lookup_customer",
    description:
      "Look up the caller's phone number in the customer directory. Call this early to personalise the greeting and confirm the service address.",
    inputSchema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          maxLength: 32,
          description: "The caller's phone number, in any common format.",
        },
      },
      required: ["phone"],
      additionalProperties: false,
    },
    handler: handleLookupCustomer,
  },
  {
    name: "reserve_technician",
    description:
      "Reserve an on-call technician. Call this once, only after you have confirmed the caller's name, address and callback number and know the urgency, trade and suburb. Returns only a reservation. No technician has been contacted. Never tell the caller a technician is on the way, and never give a technician name or an arrival time. If it fails, do not retry.",
    inputSchema: {
      type: "object",
      properties: {
        call_ref: CALL_REF_PROP,
        customer_name: {
          type: "string",
          maxLength: 80,
          description: "The caller's name, as they confirmed it.",
        },
        address: {
          type: "string",
          maxLength: 200,
          description: "The service address, as the caller confirmed it.",
        },
        callback_number: {
          type: "string",
          maxLength: 32,
          description:
            "The best phone number to reach the caller on. Never a SIP address.",
        },
        urgency: {
          type: "string",
          enum: ["emergency", "urgent"],
          description: "emergency if someone or property is at risk now, else urgent.",
        },
        trade: {
          type: "string",
          enum: ["plumbing", "electrical", "gas", "hvac", "other"],
          description: "The trade the job needs.",
        },
        suburb: {
          type: "string",
          maxLength: 60,
          description: "The suburb of the job.",
        },
        summary: {
          type: "string",
          maxLength: 200,
          description: "One short sentence describing the caller's problem.",
        },
      },
      required: [
        "customer_name",
        "address",
        "callback_number",
        "urgency",
        "trade",
        "suburb",
        "summary",
      ],
      additionalProperties: false,
    },
    handler: handleReserveTechnician,
  },
  {
    name: "create_job",
    description:
      "Record the caller's details for the technician. Call once, only after reserve_technician succeeded. Do not retry if it fails. Never promise anything beyond logging the job.",
    inputSchema: {
      type: "object",
      properties: {
        call_ref: CALL_REF_PROP,
        job_id: {
          type: "string",
          maxLength: 6,
          description: "Optional. Ignored; the server uses its own record.",
        },
        customer_name: {
          type: "string",
          maxLength: 80,
          description: "The caller's name, as they confirmed it.",
        },
        address: {
          type: "string",
          maxLength: 200,
          description: "The service address, as the caller confirmed it.",
        },
        contact_phone: {
          type: "string",
          maxLength: 32,
          description: "Optional callback phone number for the caller.",
        },
        details: {
          type: "string",
          maxLength: 500,
          description: "What the caller told you about the problem.",
        },
        hazards: {
          type: "string",
          maxLength: 200,
          description: "Optional hazards the technician should know about.",
        },
      },
      required: ["customer_name", "address", "details"],
      additionalProperties: false,
    },
    handler: handleCreateJob,
  },
  {
    name: "release_technician",
    description:
      "Release a reserved technician when the call cannot proceed. Call only if a technician was reserved. Use one reason from the list. Do not retry.",
    inputSchema: {
      type: "object",
      properties: {
        call_ref: CALL_REF_PROP,
        job_id: {
          type: "string",
          maxLength: 6,
          description: "Optional. Ignored; the server uses its own record.",
        },
        reason: {
          type: "string",
          enum: ["declined", "no_answer", "caller_hung_up", "error"],
          description: "Why the reservation cannot proceed.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    handler: handleReleaseTechnician,
  },
];
