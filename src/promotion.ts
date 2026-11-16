import { LEVEL_NAMES, clampLevel, nextSupported, snapDown } from "./levels.js";
import { RECENT_LIMIT, emptyStats, type TrustScope } from "./trust.js";
import type { Attributes, Level, Outcome, RiskClass } from "./types.js";

export interface PromotionThresholds {
  /** Attention-weighted approvals needed at the current level. `null` means manual only. */
  minApprovals: number | null;
  /** (approved + 0.5 * edited) / responses. An edit counts as half a rejection. */
  minRate: number;
  /** No rejection or undo in this many most recent outcomes. */
  cleanRun: number;
  /** Minimum time at the current level, so a single burst can't earn trust. */
  minDwellMs: number;
  /** After a declined offer, wait this long before offering again. */
  declineCooldownMs: number;
  /**
   * Promotion past Ask needs signed approvals (a project signing secret). On by default for
   * irreversible (money) and regulated actions, so an unsigned project stops at Ask.
   */
  requiresSigned?: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Default pack promotion thresholds by risk class . These are only
 * defaults. A config overrides them per risk class (`promotion`) and per action class
 * (`ActionClass.promotion`), and rule packs ship their own. See promotionThresholds().
 */
export const DEFAULT_PROMOTION: Record<RiskClass, PromotionThresholds> = {
  reversible_self: { minApprovals: 5, minRate: 0.9, cleanRun: 5, minDwellMs: HOUR, declineCooldownMs: DAY },
  reversible_shared: { minApprovals: 10, minRate: 0.9, cleanRun: 5, minDwellMs: DAY, declineCooldownMs: DAY },
  hard_to_reverse: { minApprovals: 20, minRate: 0.95, cleanRun: 5, minDwellMs: 3 * DAY, declineCooldownMs: 3 * DAY },
  irreversible: { minApprovals: 30, minRate: 0.98, cleanRun: 10, minDwellMs: 7 * DAY, declineCooldownMs: 7 * DAY, requiresSigned: true },
  regulated: { minApprovals: null, minRate: 1, cleanRun: 10, minDwellMs: 7 * DAY, declineCooldownMs: 7 * DAY, requiresSigned: true },
};

export const DEFAULT_DECAY_MS = 30 * DAY;
/** Approvals faster than this count half (attention weighting). */
export const RUSHED_MS = 2_000;
/** Rejected tripwire asks before the level drops by one. */
export const TRIPWIRE_REJECTS_TO_DEMOTE = 2;

export interface RecordOptions {
  /** The level the decision ran at (after tripwires). */
  level: Level;
  now: number;
  /** Levels the action supports, so a demotion lands on a real level. */
  supported?: readonly Level[];
  /** True when the ask came from a tripwire rather than the level. */
  tripwire?: boolean;
  /** How long the human took to answer, for attention weighting. */
  responseMs?: number;
  /** Attributes to learn into the envelope when the human accepted the action. */
  observed?: Attributes;
  /** Model and prompt versions in use, recorded when the action was accepted. */
  fingerprint?: Record<string, string>;
}

export interface RecordResult {
  scope: TrustScope;
  demoted: boolean;
  /** Why the scope changed, for the event log. */
  reason?: string;
}

function demote(scope: TrustScope, now: number, supported?: readonly Level[]): TrustScope {
  const down = clampLevel(Math.max(1, scope.earned - 1));
  return {
    ...scope,
    // Drop to the next supported level below, so an email at L3 goes straight back to Ask.
    earned: supported ? (Math.max(1, snapDown(down, supported)) as Level) : down,
    levelSince: now,
    stats: emptyStats(),
    tripwireRejects: 0,
  };
}

function learn(scope: TrustScope, observed: Attributes | undefined): TrustScope["envelope"] {
  if (!observed) return scope.envelope;
  const envelope = { ...scope.envelope };
  for (const [key, raw] of Object.entries(observed)) {
    const entry = { ...envelope[key] };
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v === "number" && Number.isFinite(v)) {
        entry.min = entry.min === undefined ? v : Math.min(entry.min, v);
        entry.max = entry.max === undefined ? v : Math.max(entry.max, v);
      } else if (typeof v === "string") {
        const vals = entry.values ?? [];
        if (!vals.includes(v)) entry.values = [...vals, v].slice(-500);
      }
    }
    envelope[key] = entry;
  }
  return envelope;
}

/**
 * Apply a human outcome to a scope. Pure. Layer 1 invariants honoured here.
 * - Silence (`ignored`) counts as consent only at L2.
 * - `expired` never counts.
 * - One undo or rejection at L3 or above drops the level by one, and resets
 *   the evidence, so no approval history offsets a recent undo.
 */
export function recordOutcome(scope: TrustScope, outcome: Outcome, opts: RecordOptions): RecordResult {
  const { now, level } = opts;
  const consent = outcome === "approved" || outcome === "edited" || (outcome === "ignored" && level === 2);
  const negative = outcome === "rejected" || outcome === "undone";
  const human = outcome === "approved" || outcome === "edited" || outcome === "rejected" || outcome === "undone";

  let next: TrustScope = {
    ...scope,
    lastActivity: now,
    recent: [...scope.recent, outcome].slice(-RECENT_LIMIT),
    sinceCheck: human ? 0 : scope.sinceCheck,
  };

  if (outcome === "expired" || (outcome === "ignored" && level !== 2)) {
    return { scope: next, demoted: false };
  }

  const stats = { ...scope.stats, responses: scope.stats.responses + 1 };
  if (outcome === "approved" || outcome === "ignored") {
    stats.approved += 1;
    const rushed = opts.responseMs !== undefined && opts.responseMs < RUSHED_MS;
    stats.weightedApproved += rushed ? 0.5 : 1;
  } else if (outcome === "edited") {
    stats.edited += 1;
  } else if (outcome === "rejected") {
    stats.rejected += 1;
  } else if (outcome === "undone") {
    stats.undone += 1;
  }
  next.stats = stats;

  if (consent) {
    next.envelope = learn(scope, opts.observed);
    if (opts.fingerprint) next.fingerprint = { ...scope.fingerprint, ...opts.fingerprint };
  }

  if (negative && scope.earned >= 3 && (level >= 2 || outcome === "undone")) {
    return { scope: demote(next, now, opts.supported), demoted: true, reason: `${outcome} at L${scope.earned}` };
  }
  if (negative && opts.tripwire) {
    const rejects = (scope.tripwireRejects ?? 0) + 1;
    next = { ...next, tripwireRejects: rejects };
    if (rejects >= TRIPWIRE_REJECTS_TO_DEMOTE && scope.earned >= 2) {
      return { scope: demote(next, now, opts.supported), demoted: true, reason: `${rejects} rejected tripwire asks` };
    }
  }
  return { scope: next, demoted: false };
}

/** Count an allowed action that no human looked at, for re-check counters. */
export function noteUnchecked(scope: TrustScope, now: number): TrustScope {
  return { ...scope, sinceCheck: scope.sinceCheck + 1, lastActivity: now };
}

export interface PromotionStatus {
  eligible: boolean;
  current: Level;
  next: Level | null;
  /** Machine-readable reasons it is not eligible yet. */
  missing: string[];
  /** The offer, in the agent's words, when eligible. */
  message?: string;
  progress: { approvals: number; needed: number | null; rate: number; dwellMs: number };
}

/** The offer, keyed by the level being offered (not the current one), since promotion can skip unsupported levels. */
const OFFER: Partial<Record<Level, string>> = {
  2: "Want me to give you a heads up and go ahead unless you stop me?",
  3: "Want me to just do them and tell you after?",
  4: "Want me to just do them and send you a summary?",
  5: "Want me to handle these on my own? You can always stop me.",
};

export function promotionStatus(
  scope: TrustScope,
  thresholds: PromotionThresholds,
  ceiling: Level,
  now: number,
  /** Levels the action supports. Promotion goes to the next supported one (layer 1 invariants 4 and 10). */
  supported: readonly Level[] = [0, 1, 2, 3, 4, 5],
  /** Whether the project requires signed approvals. Undefined means unknown, which doesn't block. */
  signed?: boolean,
): PromotionStatus {
  const s = scope.stats;
  const rate = s.responses === 0 ? 0 : (s.approved + 0.5 * s.edited) / s.responses;
  const dwellMs = now - scope.levelSince;
  const progress = { approvals: s.weightedApproved, needed: thresholds.minApprovals, rate, dwellMs };
  const cap = Math.min(ceiling, scope.userCap ?? 5);
  const missing: string[] = [];

  const target = nextSupported(scope.earned, supported, clampLevel(cap));
  if (target === null) missing.push("at_ceiling");
  else if (thresholds.requiresSigned && signed === false && target > 1) missing.push("signed_approvals");
  if (thresholds.minApprovals === null) missing.push("manual_only");
  else if (s.weightedApproved < thresholds.minApprovals) missing.push("approvals");
  if (rate < thresholds.minRate) missing.push("rate");
  const tail = scope.recent.slice(-thresholds.cleanRun);
  if (tail.some((o) => o === "rejected" || o === "undone")) missing.push("recent_negative");
  if (dwellMs < thresholds.minDwellMs) missing.push("dwell");
  if (scope.declinedAt !== undefined && now - scope.declinedAt < thresholds.declineCooldownMs) missing.push("declined_recently");

  const eligible = missing.length === 0;
  const status: PromotionStatus = { eligible, current: scope.earned, next: eligible ? target : null, missing, progress };
  if (eligible && target !== null) {
    status.message = `You've approved the last ${s.approved} of these. ${OFFER[target] ?? ""}`.trim();
  }
  return status;
}

export interface Approver {
  kind: "human" | "agent";
  id: string;
}

export type PromotionResult =
  | { ok: true; scope: TrustScope; from: Level; to: Level }
  | { ok: false; error: "approver_not_human" | "not_eligible"; missing?: string[] };

/**
 * Accept an offered promotion. One level at a time, never silent, and an agent
 * can never approve its own request (layer 1 invariants 4 and 6).
 */
export function acceptPromotion(
  scope: TrustScope,
  args: { approver: Approver; thresholds: PromotionThresholds; ceiling: Level; now: number; supported?: readonly Level[]; signed?: boolean },
): PromotionResult {
  if (args.approver.kind !== "human") return { ok: false, error: "approver_not_human" };
  const status = promotionStatus(scope, args.thresholds, args.ceiling, args.now, args.supported, args.signed);
  if (!status.eligible || status.next === null) return { ok: false, error: "not_eligible", missing: status.missing };
  return {
    ok: true,
    from: scope.earned,
    to: status.next,
    scope: { ...scope, earned: status.next, levelSince: args.now, stats: emptyStats(), declinedAt: undefined },
  };
}

/**
 * The thresholds for one action class. The risk class default, then the config's override for
 * that risk class, then the action class's own override, each field by field. `requiresSigned`
 * can only be switched on.
 */
export function promotionThresholds(
  risk: RiskClass,
  overrides: { risk?: Partial<PromotionThresholds>; action?: Partial<PromotionThresholds> } = {},
): PromotionThresholds {
  const base = DEFAULT_PROMOTION[risk];
  const merged = { ...base, ...overrides.risk, ...overrides.action };
  // Overrides can require signing for more classes, never drop it for money and irreversible.
  if (base.requiresSigned || overrides.risk?.requiresSigned || overrides.action?.requiresSigned) merged.requiresSigned = true;
  return merged;
}

export function declinePromotion(scope: TrustScope, now: number): TrustScope {
  return { ...scope, declinedAt: now };
}

/** Trust decays. One level per full gap of inactivity, never below L1. */
export function decay(scope: TrustScope, now: number, gapMs = DEFAULT_DECAY_MS): TrustScope {
  if (scope.lastActivity === undefined || scope.earned <= 1) return scope;
  const gaps = Math.floor((now - scope.lastActivity) / gapMs);
  if (gaps <= 0) return scope;
  const earned = clampLevel(Math.max(1, scope.earned - gaps));
  if (earned === scope.earned) return scope;
  return { ...scope, earned, levelSince: now, stats: emptyStats() };
}

/** The human sets a level by hand ("always ask me about this"). Never above the ceiling. */
export function setUserCap(scope: TrustScope, cap: Level | undefined): TrustScope {
  if (cap === undefined) return { ...scope, userCap: undefined };
  return { ...scope, userCap: cap, earned: Math.min(scope.earned, cap) as Level };
}

export function describeLevel(level: Level): string {
  return `L${level} ${LEVEL_NAMES[level]}`;
}
