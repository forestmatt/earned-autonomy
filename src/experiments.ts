import { allMatch, anyActionMatches, type Condition, type EvalContext, type MatchEnv } from "./conditions.js";
import { bucket, inPercent } from "./hash.js";
import type { Exposure, Level } from "./types.js";

export interface Arm {
  key: string;
  /** Percentage of assigned traffic. Weights should sum to 100. */
  weight: number;
  /** The most autonomy this arm allows. Omitted means no cap (L5). */
  autonomyCap?: Level;
  params?: Record<string, unknown>;
}

export interface Experiment {
  key: string;
  status: "draft" | "running" | "stopped";
  arms: Arm[];
  /** Percentage of eligible subjects enrolled (0 to 100). */
  traffic: number;
  /** Action patterns this experiment applies to. Omitted means all. */
  actions?: string[];
  when?: Condition[];
  /** Context kind to randomise on. Defaults to `subject`. */
  bucketBy?: string;
  salt?: string;
  /** Experiments in the same layer are mutually exclusive. */
  layer?: string;
}

/** A layer splits its buckets between experiments, so a subject is in at most one. */
export interface Layer {
  key: string;
  /** Bucket ranges as percentages, `[start, end)`. */
  allocations: { experiment: string; start: number; end: number }[];
}

/** A global holdout. Held-out subjects skip every experiment and get the cap. */
export interface Holdout {
  key: string;
  percent: number;
  /** Autonomy cap for held-out subjects. Defaults to L5 (no cap, just no experiments). */
  autonomyCap?: Level;
  actions?: string[];
  bucketBy?: string;
}

export interface Assignment {
  experiment: string;
  arm: Arm;
}

export interface ExperimentOutcome {
  cap: Level;
  /** `experiment:<exp>/<arm>` or `holdout:<key>` when something capped the level. */
  binding?: string;
  exposures: Exposure[];
  assignments: Assignment[];
  heldOut?: string;
}

export interface ExperimentConfig extends MatchEnv {
  experiments?: Experiment[];
  layers?: Layer[];
  holdouts?: Holdout[];
}

function keyFor(ctx: EvalContext, kind = "subject"): string | undefined {
  return ctx[kind]?.key;
}

/** Deterministic arm for a subject, or null when not enrolled. */
export function assignArm(exp: Experiment, ctx: EvalContext, config: ExperimentConfig = {}): Arm | null {
  if (exp.status !== "running" || exp.arms.length === 0) return null;
  const key = keyFor(ctx, exp.bucketBy);
  if (key === undefined) return null;
  if (!allMatch(exp.when, ctx, config)) return null;

  const salt = exp.salt ?? exp.key;
  if (exp.layer) {
    const layer = config.layers?.find((l) => l.key === exp.layer);
    const alloc = layer?.allocations.find((a) => a.experiment === exp.key);
    if (!layer || !alloc) return null;
    const b = bucket(`layer:${layer.key}`, key);
    if (b < Math.round(alloc.start * 100) || b >= Math.round(alloc.end * 100)) return null;
  }
  // Traffic uses its own salt so ramping traffic never reshuffles arms.
  if (!inPercent(`${salt}:traffic`, key, exp.traffic)) return null;

  const b = bucket(salt, key);
  let cumulative = 0;
  for (const arm of exp.arms) {
    cumulative += Math.round(arm.weight * 100);
    if (b < cumulative) return arm;
  }
  return exp.arms[exp.arms.length - 1]!;
}

/** Holdouts first, then every running experiment that applies to this action. */
export function evaluateExperiments(
  config: ExperimentConfig,
  ctx: EvalContext,
  action: string,
): ExperimentOutcome {
  for (const h of config.holdouts ?? []) {
    if (!anyActionMatches(h.actions, action)) continue;
    const key = keyFor(ctx, h.bucketBy);
    if (key === undefined) continue;
    if (inPercent(`holdout:${h.key}`, key, h.percent)) {
      const cap = h.autonomyCap ?? 5;
      return {
        cap,
        binding: cap < 5 ? `holdout:${h.key}` : undefined,
        exposures: [{ experiment: h.key, arm: "holdout", holdout: true }],
        assignments: [],
        heldOut: h.key,
      };
    }
  }

  let cap: Level = 5;
  let binding: string | undefined;
  const exposures: Exposure[] = [];
  const assignments: Assignment[] = [];
  for (const exp of config.experiments ?? []) {
    if (!anyActionMatches(exp.actions, action)) continue;
    const arm = assignArm(exp, ctx, config);
    if (!arm) continue;
    assignments.push({ experiment: exp.key, arm });
    exposures.push({ experiment: exp.key, arm: arm.key });
    if (arm.autonomyCap !== undefined && arm.autonomyCap < cap) {
      cap = arm.autonomyCap;
      binding = `experiment:${exp.key}/${arm.key}`;
    }
  }
  return { cap, binding, exposures, assignments };
}
