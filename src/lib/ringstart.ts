// src/lib/ringstart.ts
// D20-5a ring start: resolves ring_mode (fail safe), enforces the daily cap,
// builds the candidate list (the job's reserved technician first, then the
// S1.9 trade-eligibility walk excluding them, minus anyone inside the
// per-technician cooldown) and feeds one "start" event through runRing.
// Never throws, never logs phone numbers; mode "off" never reaches runRing.
// deps (buildRingDeps factory) and the clock are injectable for tests.

import { readConfig } from "./config";
import { log } from "./log";
import { TECH_POOL, TECH_PROFILES, type Trade } from "./pool";
import type { RingMode } from "./ring";
import { runRing, type RingJob } from "./ringrun";
import {
  buildRingDeps,
  type RingDepsFactory,
  type VoiceEnv,
} from "../routes/voice";

export interface RingDirectory {
  flag(name: string): Promise<string | null>;
  bumpCounter(
    name: string,
    cap: number,
  ): Promise<{ ok: boolean; count: number }>;
}

export interface StartRingEnv extends VoiceEnv {
  DIRECTORY?: { idFromName(name: string): RingDirectory };
}

export interface StartRingOpts {
  // Caller override (the ring-test route); replaces the flag when given and
  // can never be "off".
  mode?: "dry_run" | "live";
  now?: number;
  depsFor?: RingDepsFactory;
}

// D20-5d: why a ring start did (not) run, so a failed or skipped start leaves
// a visible reason on the job (persisted by JobActor.alarm) instead of silence.
export type RingStartReason =
  | "ok"
  | "mode_off"
  | "capped"
  | "no_job"
  | "no_candidates"
  | "deps_error"
  | "run_error";

export interface StartRingResult {
  mode: RingMode;
  started: boolean;
  reason: RingStartReason;
}

// Bounded integer setting: the default when unset or not an integer in range.
function intSetting(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

// Spec 1.7: a missing key or ANY other value is "dry_run" (fail safe). A flag
// read error is also dry_run.
async function readMode(env: StartRingEnv): Promise<RingMode> {
  try {
    const dir = env.DIRECTORY?.idFromName("directory");
    const v = dir === undefined ? null : await dir.flag("ring_mode");
    if (v === "off") return "off";
    if (v === "live") return "live";
    return "dry_run";
  } catch {
    return "dry_run";
  }
}

// Daily cap bump: true means blocked (cap hit, or the counter failed — both
// fail safe, the ring never proceeds on a counter error).
async function capBlocked(env: StartRingEnv): Promise<boolean> {
  try {
    const dir = env.DIRECTORY?.idFromName("directory");
    if (dir === undefined) return true;
    const cap = intSetting(readConfig(env, "RING_DAILY_CAP"), 20, 1, 1000);
    return !(await dir.bumpCounter("ring", cap)).ok;
  } catch {
    return true;
  }
}

// Reserved technician first, then the other trade-eligible technicians in
// pool order (S1.9 walk), never duplicated and never the reserved one twice.
// A missing job record yields an empty list (the job then ends exhausted).
function buildCandidates(
  job: (RingJob & { tech_id?: unknown }) | null,
): string[] {
  const first =
    typeof job?.tech_id === "string" && job.tech_id !== ""
      ? job.tech_id
      : undefined;
  const out: string[] = first === undefined ? [] : [first];
  const trade = typeof job?.trade === "string" ? (job.trade as Trade) : undefined;
  if (trade !== undefined) {
    for (const id of TECH_POOL) {
      if (!out.includes(id) && TECH_PROFILES[id].trades.includes(trade)) {
        out.push(id);
      }
    }
  }
  return out;
}

// Drop technicians whose last ring started inside RING_COOLDOWN_S (default
// 60, 0 disables). A missing/unreadable status keeps the candidate (soft
// guard; the daily cap is the hard one).
async function filterCooldown(
  deps: ReturnType<RingDepsFactory>,
  env: StartRingEnv,
  candidates: string[],
  now: number,
): Promise<string[]> {
  const cd = intSetting(readConfig(env, "RING_COOLDOWN_S"), 60, 0, 86400);
  if (cd === 0) return candidates;
  const out: string[] = [];
  for (const id of candidates) {
    let blocked = false;
    try {
      const st = await deps.tech(id).status?.();
      const last = (st as { last_ring_at?: unknown } | undefined)?.last_ring_at;
      blocked = typeof last === "number" && now - last < cd * 1000;
    } catch {
      blocked = false;
    }
    if (!blocked) out.push(id);
  }
  return out;
}

export async function startRing(
  env: StartRingEnv,
  callActor: string,
  opts: StartRingOpts = {},
): Promise<StartRingResult> {
  let mode: RingMode = "dry_run";
  try {
    const now = opts.now ?? Date.now();
    const depsFor = opts.depsFor ?? buildRingDeps;
    mode = opts.mode ?? (await readMode(env));
    if (mode === "off") {
      log({ component: "ops", event: "ring_start", node: "off", call_ref: callActor });
      return { mode, started: false, reason: "mode_off" };
    }
    // deps build failure is its own reason: no runRing ever ran.
    let deps: ReturnType<RingDepsFactory>;
    try {
      deps = depsFor(env, callActor);
    } catch (err) {
      log({
        component: "ops",
        level: "error",
        event: "ring_start_fail",
        call_ref: callActor,
        error: err instanceof Error ? err.name : "unknown",
      });
      return { mode, started: false, reason: "deps_error" };
    }
    if (await capBlocked(env)) {
      log({ component: "ops", event: "ring_capped", call_ref: callActor });
      await runRing(deps, callActor, { type: "start", mode, candidates: [], now });
      return { mode, started: true, reason: "capped" };
    }
    let job: (RingJob & { tech_id?: unknown }) | null = null;
    try {
      job = (await deps.jobs.get()) as RingJob & { tech_id?: unknown };
    } catch {
      job = null;
    }
    const candidates = await filterCooldown(deps, env, buildCandidates(job), now);
    await runRing(deps, callActor, { type: "start", mode, candidates, now });
    const reason: RingStartReason =
      job === null ? "no_job" : candidates.length === 0 ? "no_candidates" : "ok";
    return { mode, started: true, reason };
  } catch (err) {
    log({
      component: "ops",
      level: "error",
      event: "ring_start_fail",
      call_ref: callActor,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { mode, started: false, reason: "run_error" };
  }
}
