// src/lib/ring.ts
// D20 ring core, pure logic only: (1) the dial allow/deny gate wrapped around
// an injected dialer, (2) the ring state-machine reducer. No I/O, no logging:
// the reducer returns effects as data for the caller to execute, so webhook
// retries and out-of-order events can never cause a second dial.

import { toE164 } from "./validate";

export const RING_MAX_ATTEMPTS = 2;
export const SEEN_EVENTS_CAP = 20;
export const DEFAULT_ALLOWED_PREFIXES = ["+61"];

// ---------------------------------------------------------------------------
// Dial gate (spec 1.6): allow-list prefixes plus a premium/short-number deny
// pattern, enforced immediately before the API call, after normalisation.

export interface DialResult {
  ok: boolean;
  call_control_id?: string;
  reason?: string;
}

// Optional metadata for the Telnyx Dial command (spec section 6): the gated
// wrapper passes these straight through to the injected dialer.
export interface DialerOpts {
  client_state?: string;
  command_id?: string;
}

export type Dialer = (toDigits: string, opts?: DialerOpts) => Promise<DialResult>;

// Denied right after the country code: 1900 premium, 13/18 service, and the
// AU emergency or relay numbers 000 / 112 / 106. Applies even inside "+61".
const DENIED_AFTER_CC = ["1900", "13", "18", "000", "112", "106"] as const;

export function checkDialAllowed(
  e164: string,
  prefixes: string[] = DEFAULT_ALLOWED_PREFIXES,
): { allowed: boolean; reason?: string } {
  const hit = prefixes.find((p) => e164.startsWith(p));
  if (hit === undefined) return { allowed: false, reason: "prefix" };
  const rest = e164.slice(hit.length);
  if (DENIED_AFTER_CC.some((d) => rest.startsWith(d))) {
    return { allowed: false, reason: "denied_pattern" };
  }
  return { allowed: true };
}

export function parseAllowedPrefixes(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return list.length > 0 ? list : [...DEFAULT_ALLOWED_PREFIXES];
}

// Wraps any dialer: rejects non-allow-listed / premium numbers as data, never
// throws, and converts a throwing dialer into an error result.
export function withDialGate(
  rawPrefixes: string | string[] | undefined,
  dialer: Dialer,
): Dialer {
  const prefixes = Array.isArray(rawPrefixes)
    ? rawPrefixes
    : parseAllowedPrefixes(rawPrefixes);
  return async (toDigits: string, opts?: DialerOpts): Promise<DialResult> => {
    const check = checkDialAllowed(toE164(toDigits), prefixes);
    if (!check.allowed) return { ok: false, reason: check.reason };
    try {
      return await dialer(toDigits, opts);
    } catch {
      return { ok: false, reason: "dialer_error" };
    }
  };
}

// ---------------------------------------------------------------------------
// Ring state machine (spec 1.1, 1.3, 1.4). Candidates = eligible technician
// ids in priority order, supplied by the caller's eligibility walk at start;
// the harness executes each effect and feeds webhook events back in.

export type RingMode = "off" | "dry_run" | "live";
export type RingStatus =
  | "idle"
  | "dialing"
  | "reserving"
  | "prompting"
  | "accepted"
  | "exhausted"
  | "dry_run"
  | "disabled";
export type RingOutcome =
  | "accepted"
  | "declined"
  | "no_answer"
  | "no_input"
  | "hung_up"
  | "dial_failed";

export interface RingCurrent {
  technician_id: string;
  call_control_id: string; // "" until the dial command returns
  started_at: number;
}

export interface RingOutcomeEntry {
  technician_id: string;
  outcome: RingOutcome;
  at: number;
}

export interface RingState {
  mode: RingMode;
  status: RingStatus;
  attempt: number; // 0 before start
  tried: string[];
  current?: RingCurrent;
  // A declined leg awaiting its confirmation speech: the voice route hangs
  // THIS ccid up on call.speak.ended (accept uses status === "accepted").
  confirm_ccid?: string;
  seen_event_ids: string[]; // capped at SEEN_EVENTS_CAP
  outcome_log: RingOutcomeEntry[];
  candidates: string[];
}

export type RingEvent =
  | { type: "start"; mode: RingMode; candidates: string[]; now: number }
  | { type: "dial_result"; ok: boolean; call_control_id?: string; now: number }
  | { type: "reserve_result"; technician_id: string; ok: boolean; now: number }
  | { type: "answered"; call_control_id: string; event_id: string; now: number }
  | { type: "gather"; call_control_id: string; digits: string; event_id: string; now: number }
  | { type: "hangup"; call_control_id: string; event_id: string; now: number };

export type RingEffect =
  | { type: "extend_hold"; technician_id: string }
  | { type: "reserve"; technician_id: string }
  | { type: "dial"; technician_id: string; attempt: number }
  | { type: "gather_prompt" }
  | { type: "confirm_hangup"; decline?: boolean }
  | { type: "release"; technician_id: string }
  | { type: "hangup_call" }
  | { type: "mark_dispatched"; technician_id: string }
  | { type: "sms_details"; technician_id: string; attempt: number }
  // D20c: one manager alert when the ring exhausts with nobody accepting
  // (never on an accepted leg; the no_candidates START path is ringstart's).
  | { type: "sms_manager" }
  | { type: "job_state"; state: "dispatched" | "unassigned" }
  | {
      type: "log";
      event: string;
      mode?: RingMode;
      technician_id?: string;
      attempt?: number;
      outcome?: RingOutcome;
      reason?: string;
    };

export function initRingState(): RingState {
  return {
    mode: "dry_run",
    status: "idle",
    attempt: 0,
    tried: [],
    seen_event_ids: [],
    outcome_log: [],
    candidates: [],
  };
}

function withSeen(state: RingState, id: string): RingState {
  const seen = [...state.seen_event_ids, id];
  while (seen.length > SEEN_EVENTS_CAP) seen.shift();
  return { ...state, seen_event_ids: seen };
}

// Guards webhook events: duplicates (same event id) and stale events (unknown
// or mismatching call_control_id) are no-ops with a log effect.
function guardWebhookEvent(
  state: RingState,
  callControlId: string,
  eventId: string,
): { state: RingState; ok: boolean; effects: RingEffect[] } {
  if (state.seen_event_ids.includes(eventId)) {
    return { state, ok: false, effects: [{ type: "log", event: "ring_dup_event" }] };
  }
  const s1 = withSeen(state, eventId);
  if (
    s1.current === undefined ||
    s1.current.call_control_id === "" ||
    s1.current.call_control_id !== callControlId
  ) {
    const tech = s1.current?.technician_id;
    return {
      state: s1,
      ok: false,
      effects: [{ type: "log", event: "ring_stale_event", ...(tech !== undefined ? { technician_id: tech } : {}) }],
    };
  }
  return { state: s1, ok: true, effects: [] };
}

// One failed attempt: record outcome, release the technician, end the
// answered leg (declined hears the thanks line, hung up on speak.ended via
// confirm_ccid; no_input hangs up at once), then escalate or exhaust.
function failAttempt(
  state: RingState,
  outcome: RingOutcome,
  now: number,
): [RingState, RingEffect[]] {
  const tech = state.current!.technician_id;
  const s1: RingState = {
    ...state,
    outcome_log: [...state.outcome_log, { technician_id: tech, outcome, at: now }],
  };
  const effects: RingEffect[] = [
    { type: "log", event: "ring_outcome", technician_id: tech, attempt: state.attempt, outcome },
    { type: "release", technician_id: tech },
  ];
  if (outcome === "declined") {
    s1.confirm_ccid = state.current!.call_control_id;
    effects.push({ type: "confirm_hangup", decline: true });
  } else if (outcome === "no_input") {
    effects.push({ type: "hangup_call" });
  }
  const [s2, esc] = escalate(s1, now);
  return [s2, [...effects, ...esc]];
}

// Picks the next eligible candidate and asks the harness to reserve them; the
// attempt is counted only when reserve_result comes back ok (see below).
function escalate(state: RingState, now: number): [RingState, RingEffect[]] {
  const next = state.candidates.find((c) => !state.tried.includes(c));
  if (state.attempt >= RING_MAX_ATTEMPTS || next === undefined) {
    const reason = state.attempt >= RING_MAX_ATTEMPTS ? "max_attempts" : "no_eligible";
    const s: RingState = { ...state, status: "exhausted", current: undefined };
    return [
      s,
      [
        { type: "job_state", state: "unassigned" },
        { type: "sms_manager" },
        { type: "log", event: "ring_exhausted", attempt: state.attempt, reason },
      ],
    ];
  }
  const s: RingState = {
    ...state,
    status: "reserving",
    current: { technician_id: next, call_control_id: "", started_at: now },
  };
  return [
    s,
    [
      { type: "log", event: "ring_escalate", technician_id: next, attempt: state.attempt + 1 },
      { type: "reserve", technician_id: next },
    ],
  ];
}

export function reduceRing(
  state: RingState,
  event: RingEvent,
): [RingState, RingEffect[]] {
  switch (event.type) {
    case "start": {
      if (state.status !== "idle") return [state, []]; // one ring per job
      if (event.mode === "off") {
        const s: RingState = { ...state, mode: "off", status: "disabled" };
        return [s, [{ type: "log", event: "ring_start", mode: "off" }]];
      }
      if (event.candidates.length === 0) {
        const s: RingState = {
          ...state,
          mode: event.mode,
          candidates: [],
          status: "exhausted",
        };
        return [
          s,
          [
            { type: "log", event: "ring_start", mode: event.mode },
            { type: "job_state", state: "unassigned" },
            { type: "log", event: "ring_exhausted", attempt: 0, reason: "no_candidates" },
          ],
        ];
      }
      const tech = event.candidates[0];
      if (event.mode === "dry_run") {
        // Nothing dials: log what would be dialled for attempt 1 and end.
        const s: RingState = {
          ...state,
          mode: "dry_run",
          candidates: event.candidates,
          status: "dry_run",
        };
        return [
          s,
          [{ type: "log", event: "ring_dry_run", technician_id: tech, attempt: 1 }],
        ];
      }
      const s: RingState = {
        ...state,
        mode: event.mode,
        candidates: event.candidates,
        status: "dialing",
        attempt: 1,
        tried: [tech],
        current: { technician_id: tech, call_control_id: "", started_at: event.now },
      };
      return [
        s,
        [
          { type: "log", event: "ring_start", mode: event.mode, technician_id: tech, attempt: 1 },
          { type: "extend_hold", technician_id: tech },
          { type: "dial", technician_id: tech, attempt: 1 },
        ],
      ];
    }

    case "dial_result": {
      if (state.status !== "dialing" || state.current === undefined) return [state, []];
      const tech = state.current.technician_id;
      if (event.ok && typeof event.call_control_id === "string") {
        const s: RingState = {
          ...state,
          current: { ...state.current, call_control_id: event.call_control_id },
        };
        return [s, [{ type: "log", event: "ring_dial_ok", technician_id: tech, attempt: state.attempt }]];
      }
      const [s2, eff] = failAttempt(state, "dial_failed", event.now);
      return [s2, [{ type: "log", event: "ring_dial_fail", technician_id: tech, attempt: state.attempt }, ...eff]];
    }

    case "reserve_result": {
      // Only meaningful while escalate() is waiting on a reserve of this tech.
      if (
        state.status !== "reserving" ||
        state.current === undefined ||
        state.current.technician_id !== event.technician_id
      ) {
        return [state, []];
      }
      const tried = state.tried.includes(event.technician_id)
        ? state.tried
        : [...state.tried, event.technician_id];
      if (event.ok) {
        const s: RingState = {
          ...state,
          status: "dialing",
          attempt: state.attempt + 1,
          tried,
          current: { ...state.current, started_at: event.now },
        };
        return [
          s,
          [
            { type: "extend_hold", technician_id: event.technician_id },
            { type: "dial", technician_id: event.technician_id, attempt: s.attempt },
          ],
        ];
      }
      // Reserve failed: this candidate is skipped without using an attempt.
      return escalate({ ...state, tried }, event.now);
    }

    case "answered": {
      const g = guardWebhookEvent(state, event.call_control_id, event.event_id);
      if (!g.ok) return [g.state, g.effects];
      if (g.state.status !== "dialing") return [g.state, []]; // late retry
      const s: RingState = { ...g.state, status: "prompting" };
      return [
        s,
        [
          { type: "log", event: "ring_answered", technician_id: s.current!.technician_id, attempt: s.attempt },
          { type: "gather_prompt" },
        ],
      ];
    }

    case "gather": {
      const g = guardWebhookEvent(state, event.call_control_id, event.event_id);
      if (!g.ok) return [g.state, g.effects];
      const s = g.state;
      if (s.status !== "prompting") return [s, []]; // decision already taken
      const tech = s.current!.technician_id;
      const gatherLog: RingEffect = {
        type: "log",
        event: "ring_gather",
        technician_id: tech,
        attempt: s.attempt,
      };
      if (event.digits === "1") {
        const s1: RingState = {
          ...s,
          status: "accepted",
          outcome_log: [...s.outcome_log, { technician_id: tech, outcome: "accepted", at: event.now }],
        };
        return [
          s1,
          [
            gatherLog,
            { type: "log", event: "ring_outcome", technician_id: tech, attempt: s.attempt, outcome: "accepted" },
            { type: "log", event: "ring_accepted", technician_id: tech, attempt: s.attempt },
            { type: "mark_dispatched", technician_id: tech },
            { type: "job_state", state: "dispatched" },
            { type: "confirm_hangup" },
            // D20b-1: the accepting technician is texted the full details,
            // after the confirmation speech is issued; never before it.
            { type: "sms_details", technician_id: tech, attempt: s.attempt },
          ],
        ];
      }
      const [s1, eff] = failAttempt(
        s,
        event.digits === "2" ? "declined" : "no_input",
        event.now,
      );
      return [s1, [gatherLog, ...eff]];
    }

    case "hangup": {
      const g = guardWebhookEvent(state, event.call_control_id, event.event_id);
      if (!g.ok) return [g.state, g.effects];
      const s = g.state;
      if (s.status === "dialing") return failAttempt(s, "no_answer", event.now);
      if (s.status === "prompting") return failAttempt(s, "hung_up", event.now);
      return [s, []]; // terminal: the confirm_hangup echo
    }
  }
}
