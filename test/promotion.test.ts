import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMOTION,
  acceptPromotion,
  decay,
  declinePromotion,
  newScope,
  noteUnchecked,
  promotionStatus,
  recordOutcome,
  setUserCap,
  type Outcome,
  type TrustScope,
} from "../src/index.js";

const HOUR = 3_600_000;
const t0 = 1_700_000_000_000;
const self = DEFAULT_PROMOTION.reversible_self; // 5 approvals, 90%, 1 hour

function feed(scope: TrustScope, outcomes: Outcome[], level = scope.earned, start = t0): TrustScope {
  let s = scope;
  outcomes.forEach((o, i) => {
    s = recordOutcome(s, o, { level, now: start + i * 1000, observed: { to: `p${i % 2}` } }).scope;
  });
  return s;
}

describe("promotion", () => {
  it("becomes eligible after enough clean approvals and time", () => {
    const s = feed(newScope(t0), Array(5).fill("approved"));
    expect(promotionStatus(s, self, 5, t0 + 10_000).missing).toEqual(["dwell"]);
    const st = promotionStatus(s, self, 5, t0 + HOUR + 1);
    expect(st).toMatchObject({ eligible: true, current: 1, next: 2 });
    expect(st.message).toContain("approved the last 5");
  });

  it("counts an edit as half a rejection", () => {
    const s = feed(newScope(t0), ["approved", "approved", "approved", "approved", "approved", "edited", "edited"]);
    // (5 + 1) / 7 = 0.857 < 0.9
    expect(promotionStatus(s, self, 5, t0 + 2 * HOUR).missing).toContain("rate");
  });

  it("weights rushed approvals at half", () => {
    let s = newScope(t0);
    for (let i = 0; i < 5; i++) s = recordOutcome(s, "approved", { level: 1, now: t0 + i, responseMs: 500 }).scope;
    expect(s.stats.weightedApproved).toBe(2.5);
    expect(promotionStatus(s, self, 5, t0 + 2 * HOUR).missing).toContain("approvals");
  });

  it("requires a clean recent run (safety is a floor)", () => {
    const s = feed(newScope(t0), [...Array(20).fill("approved"), "rejected"]);
    expect(promotionStatus(s, { ...self, minRate: 0.5 }, 5, t0 + 2 * HOUR).missing).toContain("recent_negative");
  });

  it("never promotes past the ceiling, the user cap, or manual-only classes", () => {
    const s = feed(newScope(t0), Array(40).fill("approved"));
    expect(promotionStatus(s, self, 1, t0 + 2 * HOUR).missing).toContain("at_ceiling");
    expect(promotionStatus({ ...s, userCap: 1 }, self, 5, t0 + 2 * HOUR).missing).toContain("at_ceiling");
    expect(promotionStatus(s, DEFAULT_PROMOTION.regulated, 5, t0 + 30 * 24 * HOUR).missing).toContain("manual_only");
  });

  it("is accepted only by a human, one level at a time", () => {
    const s = feed(newScope(t0), Array(5).fill("approved"));
    const now = t0 + 2 * HOUR;
    expect(acceptPromotion(s, { approver: { kind: "agent", id: "inbox" }, thresholds: self, ceiling: 5, now })).toEqual({
      ok: false,
      error: "approver_not_human",
    });
    const r = acceptPromotion(s, { approver: { kind: "human", id: "u1" }, thresholds: self, ceiling: 5, now });
    expect(r).toMatchObject({ ok: true, from: 1, to: 2 });
    if (!r.ok) throw new Error("unreachable");
    expect(r.scope.stats.responses).toBe(0);
    // Evidence resets, so it can't immediately jump again.
    expect(acceptPromotion(r.scope, { approver: { kind: "human", id: "u1" }, thresholds: self, ceiling: 5, now }).ok).toBe(false);
  });

  it("respects a declined offer for the cooldown", () => {
    const s = declinePromotion(feed(newScope(t0), Array(5).fill("approved")), t0 + 2 * HOUR);
    expect(promotionStatus(s, self, 5, t0 + 3 * HOUR).missing).toContain("declined_recently");
    expect(promotionStatus(s, self, 5, t0 + 30 * HOUR).eligible).toBe(true);
  });
});

describe("outcomes and demotion", () => {
  it("drops one level on an undo or rejection at L3 or above", () => {
    const s: TrustScope = { ...newScope(t0, 3), stats: { ...newScope(t0).stats, approved: 50, weightedApproved: 50, responses: 50 } };
    const r = recordOutcome(s, "undone", { level: 3, now: t0 + 1 });
    expect(r).toMatchObject({ demoted: true, reason: "undone at L3" });
    expect(r.scope.earned).toBe(2);
    expect(r.scope.stats.approved).toBe(0);
  });

  it("does not demote below L1 or on a rejection at L1", () => {
    const r = recordOutcome(newScope(t0), "rejected", { level: 1, now: t0 });
    expect(r.demoted).toBe(false);
    expect(r.scope.earned).toBe(1);
  });

  it("demotes after repeated rejected tripwire asks", () => {
    let s = newScope(t0, 2);
    s = recordOutcome(s, "rejected", { level: 1, now: t0, tripwire: true }).scope;
    expect(s.earned).toBe(2);
    const r = recordOutcome(s, "rejected", { level: 1, now: t0 + 1, tripwire: true });
    expect(r.demoted).toBe(true);
    expect(r.scope.earned).toBe(1);
  });

  it("counts silence as consent only at L2, and never counts expired", () => {
    expect(recordOutcome(newScope(t0, 2), "ignored", { level: 2, now: t0 }).scope.stats.approved).toBe(1);
    expect(recordOutcome(newScope(t0), "ignored", { level: 1, now: t0 }).scope.stats.responses).toBe(0);
    expect(recordOutcome(newScope(t0), "expired", { level: 1, now: t0 }).scope.stats.responses).toBe(0);
  });

  it("learns the envelope and fingerprint only from accepted actions", () => {
    let s = recordOutcome(newScope(t0), "approved", { level: 1, now: t0, observed: { to: "a@x.com", amount: 40 }, fingerprint: { model: "m1" } }).scope;
    s = recordOutcome(s, "approved", { level: 1, now: t0, observed: { to: "b@x.com", amount: 90 } }).scope;
    s = recordOutcome(s, "rejected", { level: 1, now: t0, observed: { to: "evil@x.com", amount: 9000 } }).scope;
    expect(s.envelope.to?.values).toEqual(["a@x.com", "b@x.com"]);
    expect(s.envelope.amount).toEqual({ min: 40, max: 90 });
    expect(s.fingerprint).toEqual({ model: "m1" });
  });

  it("resets the re-check counter on a human response", () => {
    let s = noteUnchecked(noteUnchecked(newScope(t0), t0), t0);
    expect(s.sinceCheck).toBe(2);
    s = recordOutcome(s, "approved", { level: 3, now: t0 }).scope;
    expect(s.sinceCheck).toBe(0);
  });
});

describe("decay and manual caps", () => {
  it("drops one level per 30 days idle, not below L1", () => {
    const s = { ...newScope(t0, 4), lastActivity: t0 };
    expect(decay(s, t0 + 29 * 24 * HOUR).earned).toBe(4);
    expect(decay(s, t0 + 31 * 24 * HOUR).earned).toBe(3);
    expect(decay(s, t0 + 365 * 24 * HOUR).earned).toBe(1);
  });

  it("lets the human cap a scope by hand", () => {
    const s = setUserCap(newScope(t0, 4), 1);
    expect(s).toMatchObject({ earned: 1, userCap: 1 });
    expect(setUserCap(s, undefined).userCap).toBeUndefined();
  });
});
