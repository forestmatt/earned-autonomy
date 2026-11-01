import { describe, expect, it } from "vitest";
import { checkEntitlement, type Plan } from "../src/index.js";

const plans: Record<string, Plan> = {
  free: { key: "free", features: { send: false, draft: true }, ceilings: { hard_to_reverse: 1 } },
  pro: { key: "pro", features: { send: true, draft: true, seats: 5 } },
};
const now = 1_000_000;

describe("checkEntitlement", () => {
  it("passes when the plan includes the feature, with the plan ceiling", () => {
    expect(checkEntitlement({ feature: "draft", risk: "hard_to_reverse", subscription: { plan: "free", status: "active" }, plans, now })).toMatchObject({
      result: "pass",
      ceiling: 1,
      state: "entitled",
    });
  });

  it("denies with an upgrade when the plan excludes it", () => {
    expect(checkEntitlement({ feature: "send", risk: "hard_to_reverse", subscription: { plan: "free", status: "active" }, plans, now })).toMatchObject({
      result: "deny",
      upgrade: true,
      id: "entitlement:send",
      state: "not_in_plan",
    });
  });

  it("treats past_due and grace as entitled until grace ends", () => {
    const sub = { plan: "pro", status: "grace" as const, graceUntil: now + 1 };
    expect(checkEntitlement({ feature: "send", risk: "hard_to_reverse", subscription: sub, plans, now }).result).toBe("pass");
    expect(checkEntitlement({ feature: "send", risk: "hard_to_reverse", subscription: sub, plans, now: now + 2 }).state).toBe("lapsed");
  });

  it("applies the lapsed policy when a subscriber used to pay", () => {
    const sub = { plan: "pro", status: "lapsed" as const };
    expect(checkEntitlement({ feature: "draft", risk: "reversible_self", subscription: sub, plans, now })).toMatchObject({
      result: "ask",
      id: "entitlement:lapsed/draft",
    });
    expect(checkEntitlement({ feature: "send", risk: "hard_to_reverse", subscription: sub, plans, now }).result).toBe("deny");
    expect(
      checkEntitlement({ feature: "send", risk: "hard_to_reverse", subscription: sub, plans, now, actionLapsed: { outcome: "cap", level: 2 } }),
    ).toMatchObject({ result: "cap", ceiling: 2 });
  });

  it("handles no subscription, unknown plans and numeric features", () => {
    expect(checkEntitlement({ feature: "send", risk: "irreversible", plans, now }).state).toBe("no_subscription");
    expect(checkEntitlement({ feature: "send", risk: "irreversible", subscription: { plan: "gold", status: "active" }, plans, now }).state).toBe("unknown_plan");
    expect(checkEntitlement({ feature: "seats", risk: "irreversible", subscription: { plan: "pro", status: "active" }, plans, now }).result).toBe("pass");
    expect(checkEntitlement({ risk: "irreversible", plans, now }).result).toBe("pass");
  });
});
