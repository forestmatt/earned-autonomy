import { anyActionMatches, type EvalContext } from "./conditions.js";
import type { TrustScope } from "./trust.js";
import type { Attributes, Level, RiskClass } from "./types.js";

/**
 * Layer 2. Typed rules, configured per app. Every rule reads the context and
 * can only lower a level or force an ask, never raise anything.
 */
export type RuleEffect =
  | { effect: "ask"; id: string; message: string; detail?: string }
  | { effect: "cap"; level: Level; id: string; message: string; detail?: string }
  | { effect: "deny"; id: string; message: string; detail?: string };

export interface RuleInput {
  action: string;
  risk: RiskClass;
  reversible: boolean;
  /** Attributes of this action (the `context` kind). */
  attrs: Attributes;
  ctx: EvalContext;
  resource?: string;
  trust?: TrustScope;
  /** Effective level before rules. */
  level: Level;
  /** What each budget has spent in its window before this call, by budget id. Supplied by the host. */
  usage?: Usage;
}

/** Spent so far in each budget's window, by budget id. A count of calls, or the sum of the cost field. */
export type Usage = Record<string, number>;

interface RuleBase {
  /** Action patterns the rule applies to. Omitted means all. */
  actions?: string[];
  /** Only applies at or above this level. Defaults to L2, since L0 and L1 ask anyway. */
  minLevel?: Level;
}

/** A value never seen while earning (new recipient, payee, domain, path). */
export interface NoveltyRule extends RuleBase {
  type: "novelty";
  field: string;
  /** Envelope key to compare against. Defaults to `field`. */
  envelope?: string;
  label?: string;
}

/** An amount above a fixed limit or above the range seen while earning. */
export interface MagnitudeRule extends RuleBase {
  type: "magnitude";
  field: string;
  max?: number;
  /** Compare to the envelope max times this factor. Defaults to 1. */
  envelopeFactor?: number;
  useEnvelope?: boolean;
}

/** Cap irreversible actions at a level. */
export interface IrreversibleRule extends RuleBase {
  type: "irreversible";
  cap: Level;
}

/** Model, prompt or tool schema changed since the level was earned. */
export interface DriftRule extends RuleBase {
  type: "drift";
  fields: string[];
}

/** The agent reports low confidence. */
export interface ConfidenceRule extends RuleBase {
  type: "confidence";
  field: string;
  min: number;
}

/** The action was shaped by untrusted input (web page, inbound email, tool output). */
export interface UntrustedInputRule extends RuleBase {
  type: "untrusted_input";
  field: string;
}

/** PSD2 style. Ask again after N allowed actions without a human check. */
export interface RecheckRule extends RuleBase {
  type: "recheck";
  every: number;
}

/** A gap since the last activity. */
export interface DormancyRule extends RuleBase {
  type: "dormancy";
  afterMs: number;
}

/**
 * A rate or cost ceiling over a rolling window, counted per subject, agent or project.
 * The host keeps the counts and passes what was spent before this call in `usage[id]`.
 * The engine adds this call (1, or its cost field) and compares. Over `ask` asks, over `deny` denies.
 * Applies at every level unless `minLevel` says otherwise, since a hard limit has to stop an ask too.
 */
export interface BudgetRule extends RuleBase {
  type: "budget";
  /** Names the budget. Unique in the config. The binding is `budget:<id>`. */
  id: string;
  /** Whose spend is counted. */
  per: "subject" | "agent" | "project";
  /** Window length in ms, rolling. */
  windowMs: number;
  /** Numeric attribute holding this call's cost. Omitted counts calls, each costing 1. */
  field?: string;
  /** Soft limit. A call that would take spend above it asks. */
  ask?: number;
  /** Hard limit. A call that would take spend above it is denied. */
  deny?: number;
  /** What the agent says when the budget stops it. */
  message?: string;
}

export type RuleConfig =
  | BudgetRule
  | NoveltyRule
  | MagnitudeRule
  | IrreversibleRule
  | DriftRule
  | ConfidenceRule
  | UntrustedInputRule
  | RecheckRule
  | DormancyRule;

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function values(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => s !== undefined);
  const s = str(v);
  return s === undefined ? [] : [s];
}

/** The budgets that apply to an action, so a host knows which counts to look up before deciding. */
export function budgetsFor(rules: RuleConfig[] | undefined, action: string): BudgetRule[] {
  return (rules ?? []).filter((r): r is BudgetRule => r.type === "budget" && anyActionMatches(r.actions, action));
}

function windowName(ms: number): string {
  const units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return n === 1 ? name : `${n} ${name}s`;
    }
  }
  return `${ms}ms`;
}

function evaluateBudget(rule: BudgetRule, input: RuleInput): RuleEffect | null {
  if (rule.ask === undefined && rule.deny === undefined) return null;
  const id = `budget:${rule.id}`;
  const window = windowName(rule.windowMs);
  const spent = input.usage ? ownNumber(input.usage, rule.id) : undefined;
  if (typeof spent !== "number" || !Number.isFinite(spent)) {
    // Never default to allow. A host that can't count says so, and a human decides.
    return { effect: "ask", id, message: "I can't check my budget right now, so I'm asking first.", detail: `No usage supplied for ${rule.id}` };
  }
  let cost = 1;
  if (rule.field !== undefined) {
    const v = input.attrs[rule.field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { effect: "ask", id, message: "I can't tell what this one costs, so I'm checking first.", detail: `${rule.field} is missing or not a number` };
    }
    cost = v;
  }
  const after = spent + cost;
  const unit = rule.field ? ` ${rule.field}` : "";
  if (rule.deny !== undefined && after > rule.deny) {
    return {
      effect: "deny",
      id,
      message: rule.message ?? "That would take me over my limit, so I'm not doing it.",
      detail: `${after}${unit} would pass the limit of ${rule.deny} per ${window}`,
    };
  }
  if (rule.ask !== undefined && after > rule.ask) {
    return {
      effect: "ask",
      id,
      message: rule.message ?? "That would take me over my usual limit, so I'm checking first.",
      detail: `${after}${unit} would pass ${rule.ask} per ${window}`,
    };
  }
  return null;
}

function ownNumber(record: Record<string, number>, key: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function evaluateRule(rule: RuleConfig, input: RuleInput, now: number): RuleEffect | null {
  if (!anyActionMatches(rule.actions, input.action)) return null;
  if (input.level < (rule.minLevel ?? (rule.type === "budget" ? 0 : 2))) return null;
  const { attrs, trust } = input;

  switch (rule.type) {
    case "budget":
      return evaluateBudget(rule, input);
    case "novelty": {
      if (input.resource && trust?.trustedResources?.includes(input.resource)) return null;
      const seen = trust?.envelope[rule.envelope ?? rule.field]?.values ?? [];
      const fresh = values(attrs[rule.field]).filter((v) => !seen.includes(v));
      if (fresh.length === 0) return null;
      const label = rule.label ?? rule.field;
      return { effect: "ask", id: "tripwire:novelty", message: `This one involves a new ${label}, so I'm checking first.` };
    }
    case "magnitude": {
      const value = attrs[rule.field];
      if (typeof value !== "number") return null;
      if (rule.max !== undefined && value > rule.max) {
        return { effect: "ask", id: "tripwire:magnitude", message: `The ${rule.field} is above the usual limit, so I'm checking first.` };
      }
      if (rule.useEnvelope ?? true) {
        const max = trust?.envelope[rule.field]?.max;
        if (max === undefined) {
          return { effect: "ask", id: "tripwire:magnitude", message: `I haven't handled a ${rule.field} like this before, so I'm checking first.` };
        }
        if (value > max * (rule.envelopeFactor ?? 1)) {
          return { effect: "ask", id: "tripwire:magnitude", message: `The ${rule.field} is larger than usual, so I'm checking first.` };
        }
      }
      return null;
    }
    case "irreversible": {
      if (input.reversible || input.level <= rule.cap) return null;
      return { effect: "cap", level: rule.cap, id: "tripwire:irreversible", message: "This can't be undone, so I'll give you a chance to stop it." };
    }
    case "drift": {
      const known = trust?.fingerprint;
      if (!known) return null;
      for (const f of rule.fields) {
        const now = str(attrs[f]);
        if (now !== undefined && known[f] !== undefined && known[f] !== now) {
          return { effect: "ask", id: "tripwire:drift", message: `My ${f} changed since you last trusted me with this, so I'm checking first.` };
        }
      }
      return null;
    }
    case "confidence": {
      const c = attrs[rule.field];
      if (typeof c !== "number" || c >= rule.min) return null;
      return { effect: "ask", id: "tripwire:confidence", message: "I'm not sure about this one, so I'm checking first." };
    }
    case "untrusted_input": {
      if (!attrs[rule.field]) return null;
      return { effect: "ask", id: "tripwire:untrusted_input", message: "This came from content I can't vouch for, so I'm checking first." };
    }
    case "recheck": {
      if (!trust || trust.sinceCheck < rule.every) return null;
      return { effect: "ask", id: "tripwire:recheck", message: "It's been a while since you checked one of these, so here's one to look at." };
    }
    case "dormancy": {
      if (!trust?.lastActivity || now - trust.lastActivity < rule.afterMs) return null;
      return { effect: "ask", id: "tripwire:dormancy", message: "It's been a while since I did one of these, so I'm checking first." };
    }
  }
}
