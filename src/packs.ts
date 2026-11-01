import type { LapsedPolicy } from "./entitlements.js";
import { DEFAULT_PROMOTION, type PromotionThresholds } from "./promotion.js";
import type { RuleConfig } from "./rules.js";
import type { RiskClass } from "./types.js";

/**
 * Rule packs. A builder picks one and tunes it. They are open examples of
 * layer 2, not part of the standard.
 */
export interface RulePack {
  key: string;
  name: string;
  description: string;
  rules: RuleConfig[];
  promotion: Record<RiskClass, PromotionThresholds>;
  lapsedPolicy: LapsedPolicy;
}

const DAY = 86_400_000;

const BASE_RULES: RuleConfig[] = [
  { type: "irreversible", cap: 2 },
  { type: "drift", fields: ["model", "prompt"] },
  { type: "confidence", field: "confidence", min: 0.7 },
  { type: "untrusted_input", field: "untrustedInput" },
  { type: "dormancy", afterMs: 14 * DAY },
];

export const DEFAULT_PACK: RulePack = {
  key: "default",
  name: "Default",
  description: "Sensible tripwires for any agent. Irreversible actions get a heads up at most, and drift, low confidence and untrusted input ask.",
  rules: BASE_RULES,
  promotion: DEFAULT_PROMOTION,
  lapsedPolicy: { reversible_self: { outcome: "ask" }, default: { outcome: "deny" } },
};

export const FINTECH_PACK: RulePack = {
  key: "fintech",
  name: "Fintech",
  description: "New payees ask, amounts above the usual range ask, and PSD2 style re-checks every 5 payments.",
  rules: [
    ...BASE_RULES,
    { type: "novelty", field: "payee", label: "payee", actions: ["payment.*", "transfer.*"] },
    { type: "magnitude", field: "amount", actions: ["payment.*", "transfer.*"] },
    { type: "recheck", every: 5, actions: ["payment.*", "transfer.*"] },
  ],
  promotion: {
    ...DEFAULT_PROMOTION,
    irreversible: { ...DEFAULT_PROMOTION.irreversible, minApprovals: 30, minRate: 0.98 },
  },
  lapsedPolicy: { default: { outcome: "deny" } },
};

export const CODING_AGENT_PACK: RulePack = {
  key: "coding-agent",
  name: "Coding agent",
  description: "Stays inside the repos it has worked in. Destructive commands and new paths outside the envelope ask.",
  rules: [
    ...BASE_RULES,
    { type: "novelty", field: "repo", label: "repository" },
    { type: "novelty", field: "path", label: "path", actions: ["fs.*", "file.*"] },
    { type: "novelty", field: "command", label: "command", actions: ["shell.*", "bash.*"] },
  ],
  promotion: DEFAULT_PROMOTION,
  lapsedPolicy: { reversible_self: { outcome: "ask" }, default: { outcome: "deny" } },
};

export const COMMS_PACK: RulePack = {
  key: "comms",
  name: "Comms",
  description: "New recipients and new channels ask. Bulk sends above the usual size ask.",
  rules: [
    ...BASE_RULES,
    { type: "novelty", field: "to", label: "recipient" },
    { type: "novelty", field: "channel", label: "channel" },
    { type: "magnitude", field: "recipients", actions: ["email.*", "message.*", "sms.*"] },
  ],
  promotion: DEFAULT_PROMOTION,
  lapsedPolicy: { reversible_self: { outcome: "ask" }, default: { outcome: "deny" } },
};

export const RULE_PACKS: Record<string, RulePack> = {
  [DEFAULT_PACK.key]: DEFAULT_PACK,
  [FINTECH_PACK.key]: FINTECH_PACK,
  [CODING_AGENT_PACK.key]: CODING_AGENT_PACK,
  [COMMS_PACK.key]: COMMS_PACK,
};
