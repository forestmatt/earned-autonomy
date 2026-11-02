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

/** Default ceilings per risk class (SPEC.md, "Default ceilings by risk class"). */
export const DEFAULT_CEILINGS: Record<RiskClass, Level> = {
  reversible_self: 5,
  reversible_shared: 4,
  hard_to_reverse: 3,
  irreversible: 2,
  regulated: 1,
};

/**
 * Levels each risk class supports by default (SPEC.md, "Supported
 * levels per action class"). A heads up suits money (a scheduled action you can
 * cancel) but not an email, which people either approve or want sent with an undo.
 */
export const DEFAULT_SUPPORTED: Record<RiskClass, readonly Level[]> = {
  reversible_self: [0, 1, 2, 3, 4, 5],
  reversible_shared: [0, 1, 2, 3, 4, 5],
  hard_to_reverse: [0, 1, 3, 4],
  irreversible: [0, 1, 2],
  regulated: [0, 1],
};

/** Suggest and Ask are always supported, because asking is always safe. */
export function normaliseSupported(levels: readonly Level[]): Level[] {
  return [...new Set<Level>([0, 1, ...levels])].sort((a, b) => a - b);
}

/** Round down to the nearest supported level, never up (layer 1 invariant 10). */
export function snapDown(level: Level, supported: readonly Level[]): Level {
  let best: Level = 0;
  for (const l of supported) if (l <= level && l > best) best = l;
  return best;
}

/** The next supported level above `level`, up to `cap`, or null when there is none. */
export function nextSupported(level: Level, supported: readonly Level[], cap: Level = 5): Level | null {
  let best: Level | null = null;
  for (const l of supported) if (l > level && l <= cap && (best === null || l < best)) best = l;
  return best;
}

export const RISK_ORDER: readonly RiskClass[] = [
  "reversible_self",
  "reversible_shared",
  "hard_to_reverse",
  "irreversible",
  "regulated",
];

/**
 * Level to verdict. L0 and L1 ask, L2 allows with a delay (the recommended
 * option), L3 and above allow.
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
