import type { Condition, Segment } from "./conditions.js";
import type { LapsedPolicy, LapsedRule, Plan } from "./entitlements.js";
import type { Experiment, Holdout, Layer } from "./experiments.js";
import type { Flag } from "./flags.js";
import type { PromotionThresholds } from "./promotion.js";
import type { RuleConfig } from "./rules.js";
import { DEFAULT_SUPPORTED, normaliseSupported } from "./levels.js";
import type { Level, RiskClass } from "./types.js";

/** An action class, for example `email.send`. Keys are hierarchical. */
export interface ActionClass {
  key: string;
  risk: RiskClass;
  /** Defaults to true, except for the irreversible and regulated risk classes. */
  reversible?: boolean;
  /** Overrides the default ceiling for the risk class. */
  ceiling?: Level;
  /**
   * Levels this action supports. Defaults by risk class (DEFAULT_SUPPORTED).
   * L0 and L1 are always included. Decisions round down to the nearest one.
   */
  levels?: Level[];
  /** Plan feature that must be included. */
  feature?: string;
  /** Gate (a `Flag<Level | false>`) that rolls this action out. */
  gate?: string;
  /** Always ask, whatever the level. A string gives the reason. */
  alwaysAsk?: boolean | string;
  /** Overrides the lapsed-subscriber policy for this class. */
  lapsed?: LapsedRule;
  /**
   * What the agent says when it asks about this action at L1, for example "Can I send this email?".
   * Defaults to "Can I do this?". Tripwires, always-ask reasons and forbids keep their own words.
   */
  askMessage?: string;
  /** The heads-up window at L2. Defaults to 600 seconds. */
  delaySeconds?: number;
  /** Overrides the promotion thresholds for this action class, field by field. */
  promotion?: Partial<PromotionThresholds>;
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
  /** Overrides the Default pack promotion thresholds per risk class, field by field. */
  promotion?: Partial<Record<RiskClass, Partial<PromotionThresholds>>>;
}

/**
 * `obj[key]` for the object's own keys only. Keys come from callers (action names, flag keys, plan
 * names), and a plain lookup would find `constructor` or `toString` on the prototype.
 */
export function own<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
  return obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** The catch-all action class key. Actions nothing else matches use it, each under its own name. */
export const ANY_ACTION = "*";

/**
 * Longest matching key, so `email.send.bulk` falls back to `email.send`, then `email`. If nothing
 * matches and the config has a `*` class, the action uses that class under its own key, so every
 * unknown action earns (and loses) trust separately. Without `*`, unknown actions are undefined.
 */
export function resolveActionClass(config: Config, action: string): ActionClass | undefined {
  let key = action;
  for (;;) {
    // Own keys only, so an action called `constructor` or `toString` never resolves to a prototype.
    const found = key !== ANY_ACTION ? own(config.actions, key) : undefined;
    if (found) return found;
    const dot = key.lastIndexOf(".");
    if (dot <= 0) break;
    key = key.slice(0, dot);
  }
  const any = own(config.actions, ANY_ACTION);
  return any && action ? { ...any, key: action } : undefined;
}

/** The levels an action class supports, always including Suggest and Ask. */
export function supportedLevels(action: Pick<ActionClass, "levels" | "risk">): Level[] {
  return normaliseSupported(action.levels ?? DEFAULT_SUPPORTED[action.risk]);
}

export function isReversible(action: ActionClass): boolean {
  return action.reversible ?? (action.risk !== "irreversible" && action.risk !== "regulated");
}

export interface ConfigWarning {
  code: "unsupported_level";
  action: string;
  source: string;
  level: Level;
  /** What subjects will actually get. */
  becomes: Level;
  /** The nearest supported level above, if any, as a suggestion. */
  suggest: Level | null;
  message: string;
}

/**
 * Warn when a plan ceiling, action ceiling, rollout value or experiment cap lands on a
 * level an action doesn't support. It still works (decisions round down), but it's
 * almost always a mistake, for example "Free caps email.send at L2".
 */
export function validateConfig(config: Config): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const check = (ac: ActionClass, source: string, level: Level) => {
    const supported = supportedLevels(ac);
    if (supported.includes(level)) return;
    const becomes = supported.filter((l) => l <= level).pop() ?? 0;
    const suggest = supported.find((l) => l > level) ?? null;
    warnings.push({
      code: "unsupported_level",
      action: ac.key,
      source,
      level,
      becomes,
      suggest,
      message: `${source} caps ${ac.key} at L${level}, which ${ac.key} doesn't use, so subjects will stay at L${becomes}.` +
        (suggest !== null ? ` Did you mean L${suggest}?` : ""),
    });
  };
  const matches = (patterns: string[] | undefined, key: string) =>
    !patterns || patterns.some((p) => p === key || p === "*" || (p.endsWith(".*") && key.startsWith(p.slice(0, -1))));

  for (const ac of Object.values(config.actions)) {
    if (ac.ceiling !== undefined) check(ac, `The action's ceiling`, ac.ceiling);
    for (const plan of Object.values(config.plans ?? {})) {
      const c = plan.ceilings?.[ac.risk];
      if (c !== undefined) check(ac, `Plan "${plan.key}"`, c);
    }
    if (ac.gate) {
      const flag = own(config.flags, ac.gate);
      for (const v of flag?.variations ?? []) {
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5) check(ac, `Gate "${ac.gate}"`, v as Level);
      }
    }
    for (const exp of config.experiments ?? []) {
      if (!matches(exp.actions, ac.key)) continue;
      for (const arm of exp.arms) if (arm.autonomyCap !== undefined) check(ac, `Experiment "${exp.key}" arm "${arm.key}"`, arm.autonomyCap);
    }
  }
  return warnings;
}
