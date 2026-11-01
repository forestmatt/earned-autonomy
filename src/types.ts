/**
 * Core types for the Throttle decision engine.
 *
 * Layer 1 (the standard) is the levels, the decision order, the outcome
 * vocabulary and the reason chain. Layer 2 (rules) is in rules.ts.
 */

/** Autonomy levels L0 to L5. See docs/autonomy-levels.md. */
export type Level = 0 | 1 | 2 | 3 | 4 | 5;

export const LEVELS: readonly Level[] = [0, 1, 2, 3, 4, 5];

export type Mode =
  | "suggest"
  | "ask"
  | "heads_up"
  | "act_and_tell"
  | "act_and_summarise"
  | "autonomous";

/** The three answers. Deny is a closed gate, not a level. */
export type Verdict = "allow" | "ask" | "deny";

/**
 * Risk classes, from least to most risky. Each has a default ceiling
 * (see DEFAULT_CEILINGS in levels.ts).
 */
export type RiskClass =
  | "reversible_self"
  | "reversible_shared"
  | "hard_to_reverse"
  | "irreversible"
  | "regulated";

/** Human responses to a decision. Layer 1 invariant 8. */
export type Outcome = "approved" | "edited" | "rejected" | "undone" | "ignored" | "expired";

export type Scalar = string | number | boolean | null;
export type Attributes = Record<string, unknown>;

/** A context entity, for example an agent, subject or resource. */
export interface Entity {
  key: string;
  [attr: string]: unknown;
}

/** Context kinds built in to every evaluation, plus custom kinds such as `org`. */
export type ContextKind = "agent" | "subject" | "action" | "resource" | "context" | (string & {});

export interface DecideInput {
  agent: string | Entity;
  subject: string | Entity;
  /** Hierarchical action class key, for example `email.send`. */
  action: string;
  resource?: string | Entity;
  /** Attributes of this specific action, for example `{ to, amount, model }`. */
  context?: Attributes;
  /** Extra context kinds, for example `{ org: { key: "acme", plan: "pro" } }`. */
  kinds?: Record<string, Entity>;
}

/** One step of the reason chain. */
export interface ChainStep {
  step:
    | "health"
    | "policy"
    | "entitlement"
    | "forced"
    | "rollout"
    | "experiment"
    | "effective"
    | "tripwire"
    | "levels"
    | "mode";
  /** What happened at this step. `pass` means it did not change the result. */
  result: "pass" | "deny" | "ask" | "cap" | "skip";
  /** Machine-readable id, for example `rollout:inbox-send` or `tripwire:novelty`. */
  id: string;
  level?: Level;
  detail?: string;
}

export interface Levels {
  earned: Level;
  ceiling: Level;
  rollout: Level;
  experiment: Level;
}

export type NextStep = "none" | "approve" | "upgrade" | "request_promotion" | "wait";

export interface Exposure {
  experiment: string;
  arm: string;
  holdout?: boolean;
}

export interface Decision {
  id: string;
  decision: Verdict;
  /** Effective level after tripwires (the level this call runs at). */
  level: Level;
  mode: Mode;
  /** The binding constraint, for example `tripwire:novelty` or `mode:act_and_tell`. */
  binding: string;
  levels: Levels;
  /** A safe sentence the agent can say to the human. */
  message: string;
  chain: ChainStep[];
  next: NextStep;
  /** True when the decision used a safe default because evaluation failed. */
  fallback: boolean;
  /** At L2, how long to wait for a stop before acting. */
  delaySeconds?: number;
  exposures: Exposure[];
  /** Config version the decision was evaluated against. */
  configVersion: string;
  /** Stable hash of the inputs, for audit and dedupe. */
  inputsHash: string;
  action: string;
  agent: string;
  subject: string;
  resource?: string;
}
