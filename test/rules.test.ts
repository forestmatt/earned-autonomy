import { describe, expect, it } from "vitest";
import { evaluateRule, newScope, type RuleInput } from "../src/index.js";

const t0 = 1_700_000_000_000;
const trust = {
  ...newScope(t0, 3),
  envelope: { to: { values: ["a@x.com"] }, amount: { min: 10, max: 100 } },
  fingerprint: { model: "m1" },
  lastActivity: t0,
  sinceCheck: 5,
  trustedResources: ["acct_1"],
};
const input = (attrs: Record<string, unknown>, over: Partial<RuleInput> = {}): RuleInput => ({
  action: "payment.send",
  risk: "irreversible",
  reversible: false,
  attrs,
  ctx: {},
  trust,
  level: 3,
  ...over,
});

describe("rules", () => {
  it("novelty asks for unseen values but not seen or trusted ones", () => {
    const rule = { type: "novelty" as const, field: "to", label: "recipient" };
    expect(evaluateRule(rule, input({ to: "new@x.com" }), t0)).toMatchObject({ effect: "ask", id: "tripwire:novelty" });
    expect(evaluateRule(rule, input({ to: "a@x.com" }), t0)).toBeNull();
    expect(evaluateRule(rule, input({ to: ["a@x.com", "b@x.com"] }), t0)).not.toBeNull();
    expect(evaluateRule(rule, input({ to: "new@x.com" }, { resource: "acct_1" }), t0)).toBeNull();
  });

  it("magnitude asks above a limit or the envelope", () => {
    const rule = { type: "magnitude" as const, field: "amount" };
    expect(evaluateRule(rule, input({ amount: 50 }), t0)).toBeNull();
    expect(evaluateRule(rule, input({ amount: 101 }), t0)?.id).toBe("tripwire:magnitude");
    expect(evaluateRule({ ...rule, max: 20 }, input({ amount: 50 }), t0)?.id).toBe("tripwire:magnitude");
    expect(evaluateRule({ ...rule, envelopeFactor: 2 }, input({ amount: 150 }), t0)).toBeNull();
    expect(evaluateRule({ ...rule, field: "count" }, input({ count: 3 }), t0)?.id).toBe("tripwire:magnitude");
  });

  it("irreversible caps rather than asks", () => {
    expect(evaluateRule({ type: "irreversible", cap: 2 }, input({}), t0)).toMatchObject({ effect: "cap", level: 2 });
    expect(evaluateRule({ type: "irreversible", cap: 2 }, input({}, { reversible: true }), t0)).toBeNull();
  });

  it("drift, confidence, untrusted input, recheck and dormancy", () => {
    expect(evaluateRule({ type: "drift", fields: ["model"] }, input({ model: "m2" }), t0)?.id).toBe("tripwire:drift");
    expect(evaluateRule({ type: "drift", fields: ["model"] }, input({ model: "m1" }), t0)).toBeNull();
    expect(evaluateRule({ type: "confidence", field: "confidence", min: 0.7 }, input({ confidence: 0.4 }), t0)?.id).toBe("tripwire:confidence");
    expect(evaluateRule({ type: "untrusted_input", field: "untrustedInput" }, input({ untrustedInput: true }), t0)?.id).toBe(
      "tripwire:untrusted_input",
    );
    expect(evaluateRule({ type: "recheck", every: 5 }, input({}), t0)?.id).toBe("tripwire:recheck");
    expect(evaluateRule({ type: "recheck", every: 6 }, input({}), t0)).toBeNull();
    expect(evaluateRule({ type: "dormancy", afterMs: 1000 }, input({}), t0 + 2000)?.id).toBe("tripwire:dormancy");
  });

  it("respects action patterns and minimum level", () => {
    const rule = { type: "untrusted_input" as const, field: "u", actions: ["email.*"] };
    expect(evaluateRule(rule, input({ u: true }), t0)).toBeNull();
    expect(evaluateRule({ type: "untrusted_input", field: "u" }, input({ u: true }, { level: 1 }), t0)).toBeNull();
  });
});
