import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUPPORTED,
  decide,
  nextSupported,
  promotionStatus,
  recordOutcome,
  snapDown,
  supportedLevels,
  validateConfig,
  type Config,
  type Level,
  type TrustScope,
} from "../src/index.js";

const now = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;

const scope = (earned: Level, approved = 40): TrustScope => ({
  earned,
  levelSince: now - 30 * DAY,
  stats: { responses: approved, approved, edited: 0, rejected: 0, undone: 0, weightedApproved: approved },
  recent: Array(20).fill("approved"),
  sinceCheck: 0,
} as unknown as TrustScope);

describe("supported levels", () => {
  it("rounds down, never up", () => {
    expect(snapDown(2, [0, 1, 3, 4])).toBe(1);
    expect(snapDown(4, [0, 1, 3, 4])).toBe(4);
    expect(snapDown(5, [0, 1, 2])).toBe(2);
  });

  it("finds the next supported level within the cap", () => {
    expect(nextSupported(1, [0, 1, 3, 4])).toBe(3);
    expect(nextSupported(1, [0, 1, 3, 4], 2)).toBeNull();
    expect(nextSupported(2, [0, 1, 2])).toBeNull();
  });

  it("always includes Suggest and Ask", () => {
    expect(supportedLevels({ risk: "hard_to_reverse", levels: [3] })).toEqual([0, 1, 3]);
    expect(supportedLevels({ risk: "hard_to_reverse" })).toEqual([...DEFAULT_SUPPORTED.hard_to_reverse]);
  });
});

const config: Config = {
  version: "t",
  actions: {
    "email.send": { key: "email.send", risk: "hard_to_reverse", gate: "auto" },
    "payment.send": { key: "payment.send", risk: "irreversible" },
  },
  flags: { auto: { key: "auto", on: true, variations: [2], offVariation: 0, fallthrough: { variation: 0 } } as never },
  plans: { free: { key: "free", features: {}, ceilings: { hard_to_reverse: 2 } } },
};

describe("decide snaps to supported levels", () => {
  it("email capped at Heads up asks instead, and still names the gate", () => {
    const d = decide({ agent: "a", subject: "s", action: "email.send" }, config, { trust: scope(3) }, { now });
    expect(d).toMatchObject({ decision: "ask", level: 1, binding: "rollout:auto" });
    expect(d.chain.some((c) => c.step === "levels" && c.id === "levels:email.send")).toBe(true);
  });

  it("money supports Heads up but never Act and tell", () => {
    const d = decide({ agent: "a", subject: "s", action: "payment.send" }, config, { trust: scope(3) }, { now });
    expect(d.level).toBeLessThanOrEqual(2);
    expect(d.level).not.toBe(3);
  });
});

describe("promotion and demotion skip unsupported levels", () => {
  const t = { minApprovals: 5, minRate: 0.9, cleanRun: 5, minDwellMs: 0, declineCooldownMs: 0 };

  it("email promotes from Ask straight to Act and tell", () => {
    const p = promotionStatus(scope(1), t, 5, now, supportedLevels(config.actions["email.send"]!));
    expect(p).toMatchObject({ eligible: true, next: 3 });
    expect(p.message).toContain("tell you after");
  });

  it("can't promote email when the cap only allows Heads up", () => {
    const p = promotionStatus(scope(1), t, 2, now, supportedLevels(config.actions["email.send"]!));
    expect(p.eligible).toBe(false);
    expect(p.missing).toContain("at_ceiling");
  });

  it("an undo at Act and tell drops email straight back to Ask", () => {
    const r = recordOutcome(scope(3), "undone", { level: 3, now, supported: supportedLevels(config.actions["email.send"]!) });
    expect(r).toMatchObject({ demoted: true, scope: { earned: 1 } });
  });
});

describe("validateConfig", () => {
  it("warns when a plan caps email at a level email doesn't use", () => {
    const w = validateConfig(config);
    const plan = w.find((x) => x.source === 'Plan "free"' && x.action === "email.send");
    expect(plan).toMatchObject({ level: 2, becomes: 1, suggest: 3 });
    expect(plan?.message).toContain("Did you mean L3?");
    expect(w.some((x) => x.source === 'Gate "auto"')).toBe(true);
  });

  it("is quiet when everything lines up", () => {
    expect(validateConfig({ version: "t", actions: { "doc.draft": { key: "doc.draft", risk: "reversible_self" } } })).toEqual([]);
  });
});
