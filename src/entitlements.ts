import type { Level, RiskClass } from "./types.js";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "cancelling"
  | "lapsed"
  | "paused"
  | "none";

/** Subscription facts beside the boolean, after RevenueCat. */
export interface Subscription {
  plan: string;
  status: SubscriptionStatus;
  /** The raw state from the billing source, kept for explanation. */
  sourceStatus?: string;
  willRenew?: boolean;
  billingIssueAt?: number;
  expiresAt?: number;
  /** For `grace`, the end of the grace period (ms since epoch). */
  graceUntil?: number;
}

export type FeatureValue = boolean | number | string;

export interface Plan {
  key: string;
  features: Record<string, FeatureValue>;
  /** Autonomy ceilings by risk class for subjects on this plan. */
  ceilings?: Partial<Record<RiskClass, Level>>;
}

/** What happens to an action when the subscription that granted it has lapsed. */
export type LapsedRule = { outcome: "deny" } | { outcome: "ask" } | { outcome: "cap"; level: Level };

export type LapsedPolicy = Partial<Record<RiskClass | "default", LapsedRule>>;

/** Default pack. Used to pay means ask for low-risk work and deny the rest. */
export const DEFAULT_LAPSED_POLICY: LapsedPolicy = {
  reversible_self: { outcome: "ask" },
  default: { outcome: "deny" },
};

export interface EntitlementCheck {
  result: "pass" | "deny" | "ask" | "cap";
  /** Ceiling the plan sets for this risk class (L5 when the plan sets none). */
  ceiling: Level;
  /** `entitlement:<feature>` or `entitlement:lapsed/<feature>`. */
  id: string;
  detail: string;
  upgrade: boolean;
  state: "entitled" | "not_in_plan" | "lapsed" | "no_subscription" | "unknown_plan" | "not_required";
}

const ACTIVE: SubscriptionStatus[] = ["trialing", "active", "past_due", "grace", "cancelling"];

export function includes(value: FeatureValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return value.length > 0;
}

export function effectiveStatus(sub: Subscription, now: number): SubscriptionStatus {
  if (sub.status === "grace" && sub.graceUntil !== undefined && now > sub.graceUntil) return "lapsed";
  if (sub.status === "cancelling" && sub.expiresAt !== undefined && now > sub.expiresAt) return "lapsed";
  return sub.status;
}

export function checkEntitlement(args: {
  feature?: string;
  risk: RiskClass;
  subscription?: Subscription;
  plans: Record<string, Plan>;
  lapsedPolicy?: LapsedPolicy;
  /** Lapsed rule set on the action class, which beats the policy. */
  actionLapsed?: LapsedRule;
  now: number;
}): EntitlementCheck {
  const { feature, risk, subscription, plans, now } = args;
  const plan = subscription ? plans[subscription.plan] : undefined;
  const status = subscription ? effectiveStatus(subscription, now) : "none";
  const live = ACTIVE.includes(status);
  const ceiling: Level = (live ? plan?.ceilings?.[risk] : undefined) ?? 5;

  if (!feature) {
    return { result: "pass", ceiling, id: "entitlement:none", detail: "no feature required", upgrade: false, state: "not_required" };
  }
  const id = `entitlement:${feature}`;

  if (!subscription || status === "none") {
    return { result: "deny", ceiling, id, detail: "no subscription", upgrade: true, state: "no_subscription" };
  }
  if (!plan) {
    return { result: "deny", ceiling, id, detail: `unknown plan ${subscription.plan}`, upgrade: false, state: "unknown_plan" };
  }
  const inPlan = includes(plan.features[feature]);

  if (live) {
    if (inPlan) {
      const note = status === "active" ? "" : ` (${status})`;
      return { result: "pass", ceiling, id, detail: `plan ${plan.key}${note}`, upgrade: false, state: "entitled" };
    }
    return { result: "deny", ceiling, id, detail: `plan ${plan.key} excludes ${feature}`, upgrade: true, state: "not_in_plan" };
  }

  // Lapsed or paused. "Used to pay" is a declared policy, not a silent loss.
  if (!inPlan) {
    return { result: "deny", ceiling, id, detail: `plan ${plan.key} excludes ${feature}`, upgrade: true, state: "not_in_plan" };
  }
  const policy = args.lapsedPolicy ?? DEFAULT_LAPSED_POLICY;
  const rule = args.actionLapsed ?? policy[risk] ?? policy.default ?? { outcome: "deny" };
  const lapsedId = `entitlement:lapsed/${feature}`;
  const detail = `plan ${plan.key} is ${status}`;
  if (rule.outcome === "deny") return { result: "deny", ceiling, id: lapsedId, detail, upgrade: true, state: "lapsed" };
  if (rule.outcome === "ask") return { result: "ask", ceiling, id: lapsedId, detail, upgrade: true, state: "lapsed" };
  return {
    result: "cap",
    ceiling: Math.min(ceiling, rule.level) as Level,
    id: lapsedId,
    detail: `${detail}, capped at L${rule.level}`,
    upgrade: true,
    state: "lapsed",
  };
}
