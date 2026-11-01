import type { Condition, Segment } from "./conditions.js";
import type { LapsedPolicy, LapsedRule, Plan } from "./entitlements.js";
import type { Experiment, Holdout, Layer } from "./experiments.js";
import type { Flag } from "./flags.js";
import type { PromotionThresholds } from "./promotion.js";
import type { RuleConfig } from "./rules.js";
import type { Level, RiskClass } from "./types.js";

/** An action class, for example `email.send`. Keys are hierarchical. */
export interface ActionClass {
  key: string;
  risk: RiskClass;
  /** Defaults to true, except for the irreversible and regulated risk classes. */
  reversible?: boolean;
  /** Overrides the default ceiling for the risk class. */
  ceiling?: Level;
  /** Plan feature that must be included. */
  feature?: string;
  /** Gate (a `Flag<Level | false>`) that rolls this action out. */
  gate?: string;
  /** Always ask, whatever the level. A string gives the reason. */
  alwaysAsk?: boolean | string;
  /** Overrides the lapsed-subscriber policy for this class. */
  lapsed?: LapsedRule;
  /** The heads-up window at L2. Defaults to 600 seconds. */
  delaySeconds?: number;
  description?: string;
}

/** Forbid wins over everything except a broken config. */
export interface Policy {
  id: string;
  effect: "forbid";
  actions?: string[];
  when?: Condition[];
  message?: string;
}

/** A snapshot of everything the engine needs. The SDK caches this for local evaluation. */
export interface Config {
  version: string;
  actions: Record<string, ActionClass>;
  flags?: Record<string, Flag>;
  segments?: Record<string, Segment>;
  experiments?: Experiment[];
  layers?: Layer[];
  holdouts?: Holdout[];
  plans?: Record<string, Plan>;
  lapsedPolicy?: LapsedPolicy;
  policies?: Policy[];
  /** Kill switches. Action patterns that are denied for everyone. */
  killed?: string[];
  /** Layer 2 rules, usually from a rule pack. */
  rules?: RuleConfig[];
  promotion?: Partial<Record<RiskClass, PromotionThresholds>>;
}

/** Longest matching key, so `email.send.bulk` falls back to `email.send`, then `email`. */
export function resolveActionClass(config: Config, action: string): ActionClass | undefined {
  let key = action;
  for (;;) {
    const found = config.actions[key];
    if (found) return found;
    const dot = key.lastIndexOf(".");
    if (dot <= 0) return undefined;
    key = key.slice(0, dot);
  }
}

export function isReversible(action: ActionClass): boolean {
  return action.reversible ?? (action.risk !== "irreversible" && action.risk !== "regulated");
}
