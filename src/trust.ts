import type { Level, Outcome } from "./types.js";

/** What the subject has seen this agent do while earning its level. */
export interface EnvelopeEntry {
  values?: string[];
  min?: number;
  max?: number;
}

export interface TrustStats {
  /** Responses at the current level that count towards promotion. */
  responses: number;
  approved: number;
  edited: number;
  rejected: number;
  undone: number;
  /** Attention-weighted approvals (rushed approvals count half). */
  weightedApproved: number;
}

/**
 * Trust for one scope: agent, subject, action class and optional resource.
 * Layer 1 invariant 2. A level is never global.
 */
export interface TrustScope {
  earned: Level;
  /** When the scope reached its current level (ms since epoch). */
  levelSince: number;
  lastActivity?: number;
  stats: TrustStats;
  /** Most recent outcomes, newest last, capped at RECENT_LIMIT. */
  recent: Outcome[];
  envelope: Record<string, EnvelopeEntry>;
  /** Model and prompt versions seen while earning, for the drift rule. */
  fingerprint?: Record<string, string>;
  /** "Always ask me about this". A cap the human set by hand. */
  userCap?: Level;
  trustedResources?: string[];
  /** Allowed actions since the last explicit human check, for re-check counters. */
  sinceCheck: number;
  /** Tripwire asks the human rejected since the last level change. */
  tripwireRejects?: number;
  /** When a promotion was last offered and declined (ms), to avoid nagging. */
  declinedAt?: number;
}

export const RECENT_LIMIT = 20;

export function emptyStats(): TrustStats {
  return { responses: 0, approved: 0, edited: 0, rejected: 0, undone: 0, weightedApproved: 0 };
}

/** A fresh scope starts at L1 (Ask). */
export function newScope(now: number, earned: Level = 1): TrustScope {
  return { earned, levelSince: now, stats: emptyStats(), recent: [], envelope: {}, sinceCheck: 0 };
}

export function scopeKey(parts: { agent: string; subject: string; action: string; resource?: string }): string {
  const base = `${parts.agent}|${parts.subject}|${parts.action}`;
  return parts.resource ? `${base}|${parts.resource}` : base;
}
