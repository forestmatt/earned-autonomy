import { describe, expect, it } from "vitest";
import { DEFAULT_PROMOTION, newScope, promotionStatus, promotionThresholds, type TrustScope } from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("promotion defaults (Matt, 2026-11-02)", () => {
  it("match the agreed Default pack", () => {
    const pick = (r: keyof typeof DEFAULT_PROMOTION) => {
      const t = DEFAULT_PROMOTION[r];
      return [t.minApprovals, t.minRate, t.minDwellMs];
    };
    expect(pick("reversible_self")).toEqual([5, 0.9, HOUR]);
    expect(pick("reversible_shared")).toEqual([10, 0.9, DAY]);
    expect(pick("hard_to_reverse")).toEqual([20, 0.95, 3 * DAY]);
    expect(pick("irreversible")).toEqual([30, 0.98, 7 * DAY]);
    expect(DEFAULT_PROMOTION.regulated.minApprovals).toBeNull();
  });

  it("merge field by field, risk override then action override", () => {
    const t = promotionThresholds("hard_to_reverse", { risk: { minApprovals: 12, minRate: 0.9 }, action: { minApprovals: 8 } });
    expect(t).toMatchObject({ minApprovals: 8, minRate: 0.9, minDwellMs: 3 * DAY, cleanRun: 5 });
  });

  it("never let an override drop signing for money and irreversible", () => {
    expect(promotionThresholds("irreversible", { action: { requiresSigned: false } as never }).requiresSigned).toBe(true);
    expect(promotionThresholds("reversible_self").requiresSigned).toBeUndefined();
    expect(promotionThresholds("reversible_self", { action: { requiresSigned: true } }).requiresSigned).toBe(true);
  });
});

describe("unsigned projects stop at Ask for money and irreversible", () => {
  const t0 = 0;
  const ready = (): TrustScope => {
    const s = newScope(t0);
    return { ...s, stats: { ...s.stats, approved: 40, weightedApproved: 40, responses: 40 }, recent: Array(10).fill("approved") };
  };
  const now = t0 + 8 * DAY;
  const th = promotionThresholds("irreversible");

  it("is eligible when signed or unknown", () => {
    expect(promotionStatus(ready(), th, 5, now, [0, 1, 2, 3], true).eligible).toBe(true);
    expect(promotionStatus(ready(), th, 5, now, [0, 1, 2, 3]).eligible).toBe(true);
  });

  it("is blocked with a clear reason when unsigned", () => {
    const st = promotionStatus(ready(), th, 5, now, [0, 1, 2, 3], false);
    expect(st.eligible).toBe(false);
    expect(st.missing).toEqual(["signed_approvals"]);
  });

  it("does not affect classes that don't require signing", () => {
    expect(promotionStatus(ready(), promotionThresholds("reversible_self"), 5, now, undefined, false).eligible).toBe(true);
  });
});
