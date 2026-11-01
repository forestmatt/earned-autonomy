import { allMatch, type Condition, type EvalContext, type MatchEnv } from "./conditions.js";
import { bucket } from "./hash.js";

/** A percentage split over variations. Weights are percentages and should sum to 100. */
export interface Rollout {
  variations: { variation: number; weight: number }[];
  /** Context kind whose key is hashed. Defaults to `subject`. */
  bucketBy?: string;
}

export type Serve = { variation: number } | { rollout: Rollout };

export interface FlagRule {
  id: string;
  when?: Condition[];
  serve: Serve;
}

export interface Prerequisite {
  key: string;
  /** The prerequisite must serve this variation index. */
  variation: number;
}

/**
 * A typed flag, after LaunchDarkly. Ordered rules, a fallthrough, an off
 * variation and prerequisites. A gate is a `Flag<Level | false>`, where
 * `false` closes the gate and a level caps autonomy.
 */
export interface Flag<T = unknown> {
  key: string;
  on: boolean;
  variations: T[];
  offVariation: number;
  fallthrough: Serve;
  rules?: FlagRule[];
  prerequisites?: Prerequisite[];
  /** Salt for bucketing. Defaults to the key, so changing it reshuffles. */
  salt?: string;
  owner?: string;
  /** Expected lifetime, for stale detection. */
  lifetime?: "temporary" | "permanent";
}

export type FlagReason =
  | { kind: "OFF" }
  | { kind: "PREREQUISITE_FAILED"; prerequisite: string }
  | { kind: "RULE_MATCH"; ruleId: string; ruleIndex: number; inRollout: boolean }
  | { kind: "FALLTHROUGH"; inRollout: boolean }
  | { kind: "ERROR"; error: "FLAG_NOT_FOUND" | "MALFORMED_FLAG" | "PREREQUISITE_CYCLE" };

export interface FlagResult<T> {
  value: T | undefined;
  variation: number | undefined;
  reason: FlagReason;
}

export interface FlagEnv extends MatchEnv {
  flags?: Record<string, Flag>;
}

function serveVariation(
  flag: Flag,
  serve: Serve,
  ctx: EvalContext,
): { variation: number; inRollout: boolean } | null {
  if ("variation" in serve) return { variation: serve.variation, inRollout: false };
  const kind = serve.rollout.bucketBy ?? "subject";
  const key = ctx[kind]?.key;
  const variations = serve.rollout.variations;
  if (variations.length === 0) return null;
  // Without a key to hash, everyone gets the first variation (no random assignment).
  if (key === undefined) return { variation: variations[0]!.variation, inRollout: false };
  const b = bucket(flag.salt ?? flag.key, key);
  let cumulative = 0;
  for (const v of variations) {
    cumulative += Math.round(v.weight * 100);
    if (b < cumulative) return { variation: v.variation, inRollout: true };
  }
  // Weights summed to less than 100, so the remainder lands on the last one.
  return { variation: variations[variations.length - 1]!.variation, inRollout: true };
}

function result<T>(flag: Flag<T>, variation: number, reason: FlagReason): FlagResult<T> {
  if (variation < 0 || variation >= flag.variations.length) {
    return { value: undefined, variation: undefined, reason: { kind: "ERROR", error: "MALFORMED_FLAG" } };
  }
  return { value: flag.variations[variation], variation, reason };
}

export function evaluateFlag<T>(
  flag: Flag<T>,
  ctx: EvalContext,
  env: FlagEnv = {},
  visiting: Set<string> = new Set(),
): FlagResult<T> {
  if (visiting.has(flag.key)) {
    return { value: undefined, variation: undefined, reason: { kind: "ERROR", error: "PREREQUISITE_CYCLE" } };
  }
  if (!flag.on) return result(flag, flag.offVariation, { kind: "OFF" });

  visiting.add(flag.key);
  try {
    for (const pre of flag.prerequisites ?? []) {
      const preFlag = env.flags?.[pre.key];
      if (!preFlag) return result(flag, flag.offVariation, { kind: "PREREQUISITE_FAILED", prerequisite: pre.key });
      const r = evaluateFlag(preFlag, ctx, env, visiting);
      if (r.reason.kind === "ERROR" && r.reason.error === "PREREQUISITE_CYCLE") return r as FlagResult<T>;
      if (!preFlag.on || r.variation !== pre.variation) {
        return result(flag, flag.offVariation, { kind: "PREREQUISITE_FAILED", prerequisite: pre.key });
      }
    }

    const rules = flag.rules ?? [];
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      if (!allMatch(rule.when, ctx, env)) continue;
      const served = serveVariation(flag, rule.serve, ctx);
      if (!served) return { value: undefined, variation: undefined, reason: { kind: "ERROR", error: "MALFORMED_FLAG" } };
      return result(flag, served.variation, {
        kind: "RULE_MATCH",
        ruleId: rule.id,
        ruleIndex: i,
        inRollout: served.inRollout,
      });
    }

    const served = serveVariation(flag, flag.fallthrough, ctx);
    if (!served) return { value: undefined, variation: undefined, reason: { kind: "ERROR", error: "MALFORMED_FLAG" } };
    return result(flag, served.variation, { kind: "FALLTHROUGH", inRollout: served.inRollout });
  } finally {
    visiting.delete(flag.key);
  }
}

/** Short reason text for a chain entry. */
export function describeFlagReason(reason: FlagReason): string {
  switch (reason.kind) {
    case "OFF":
      return "flag is off";
    case "PREREQUISITE_FAILED":
      return `prerequisite ${reason.prerequisite} not met`;
    case "RULE_MATCH":
      return `rule ${reason.ruleId}${reason.inRollout ? " (in rollout)" : ""}`;
    case "FALLTHROUGH":
      return `fallthrough${reason.inRollout ? " (in rollout)" : ""}`;
    case "ERROR":
      return `error ${reason.error}`;
  }
}
