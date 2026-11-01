import type { Level, Mode, RiskClass, Verdict } from "./types.js";

export const MODES: Record<Level, Mode> = {
  0: "suggest",
  1: "ask",
  2: "heads_up",
  3: "act_and_tell",
  4: "act_and_summarise",
  5: "autonomous",
};

export const LEVEL_NAMES: Record<Level, string> = {
  0: "Suggest",
  1: "Ask",
  2: "Heads up",
  3: "Act and tell",
  4: "Act and summarise",
  5: "Autonomous",
};

/** Default ceilings per risk class (docs/autonomy-levels.md, rule 6). */
export const DEFAULT_CEILINGS: Record<RiskClass, Level> = {
  reversible_self: 5,
  reversible_shared: 4,
  hard_to_reverse: 3,
  irreversible: 2,
  regulated: 1,
};

export const RISK_ORDER: readonly RiskClass[] = [
  "reversible_self",
  "reversible_shared",
  "hard_to_reverse",
  "irreversible",
  "regulated",
];

/**
 * Level to verdict. L0 and L1 ask, L2 allows with a delay (the recommended
 * option, pending Matt), L3 and above allow.
 */
export function verdictFor(level: Level): Verdict {
  return level <= 1 ? "ask" : "allow";
}

export function clampLevel(n: number): Level {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.floor(n))) as Level;
}

export function minLevel(...levels: Level[]): Level {
  return clampLevel(Math.min(...levels));
}

export function isLevel(n: unknown): n is Level {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5;
}

/**
 * The effective level and which input bound it.
 * `effective = min(earned, ceiling, rollout, experiment)`. On a tie the
 * earlier input in the order ceiling, rollout, experiment, earned is named,
 * because a builder-set limit explains more than the track record does.
 */
export function effectiveLevel(levels: {
  earned: Level;
  ceiling: Level;
  rollout: Level;
  experiment: Level;
}): { level: Level; binding: "earned" | "ceiling" | "rollout" | "experiment" } {
  const order = ["ceiling", "rollout", "experiment", "earned"] as const;
  let binding: (typeof order)[number] = "ceiling";
  let level = levels.ceiling;
  for (const key of order) {
    if (levels[key] < level) {
      level = levels[key];
      binding = key;
    }
  }
  return { level, binding };
}
