import { describe, expect, it } from "vitest";
import { budgetsFor, decide, evaluateRule, newScope, type BudgetRule, type Config, type RuleInput } from "../src/index.js";

const t0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const input = (attrs: Record<string, unknown>, over: Partial<RuleInput> = {}): RuleInput => ({
  action: "email.send",
  risk: "hard_to_reverse",
  reversible: false,
  attrs,
  ctx: {},
  level: 3,
  ...over,
});

const sends: BudgetRule = { type: "budget", id: "sends", per: "subject", windowMs: HOUR, actions: ["email.*"], ask: 10, deny: 20 };
const spend: BudgetRule = { type: "budget", id: "spend", per: "project", windowMs: DAY, field: "amount", ask: 100, deny: 500 };

describe("budget rule", () => {
  it("counts calls. Under the soft limit passes, over it asks, over the hard limit denies", () => {
    expect(evaluateRule(sends, input({}, { usage: { sends: 0 } }), t0)).toBeNull();
    expect(evaluateRule(sends, input({}, { usage: { sends: 9 } }), t0)).toBeNull(); // the 10th is still inside
    expect(evaluateRule(sends, input({}, { usage: { sends: 10 } }), t0)).toMatchObject({ effect: "ask", id: "budget:sends", detail: "11 would pass 10 per hour" });
    expect(evaluateRule(sends, input({}, { usage: { sends: 19 } }), t0)?.effect).toBe("ask");
    expect(evaluateRule(sends, input({}, { usage: { sends: 20 } }), t0)).toMatchObject({ effect: "deny", id: "budget:sends", detail: "21 would pass the limit of 20 per hour" });
  });

  it("sums a cost field, including this call's cost", () => {
    expect(evaluateRule(spend, input({ amount: 40 }, { usage: { spend: 50 } }), t0)).toBeNull();
    expect(evaluateRule(spend, input({ amount: 60 }, { usage: { spend: 50 } }), t0)).toMatchObject({ effect: "ask", detail: "110 amount would pass 100 per day" });
    expect(evaluateRule(spend, input({ amount: 451 }, { usage: { spend: 50 } }), t0)?.effect).toBe("deny");
    // One call bigger than the whole budget is denied even with nothing spent.
    expect(evaluateRule(spend, input({ amount: 501 }, { usage: { spend: 0 } }), t0)?.effect).toBe("deny");
  });

  it("asks when it can't tell the cost or the host supplied no usage (never defaults to allow)", () => {
    for (const amount of [undefined, "40", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateRule(spend, input({ amount }, { usage: { spend: 0 } }), t0)).toMatchObject({ effect: "ask", id: "budget:spend" });
    }
    expect(evaluateRule(sends, input({}), t0)).toMatchObject({ effect: "ask", detail: "No usage supplied for sends" });
    expect(evaluateRule(sends, input({}, { usage: {} }), t0)?.effect).toBe("ask");
    // Prototype names are not usage.
    expect(evaluateRule({ ...sends, id: "constructor" }, input({}, { usage: {} }), t0)?.effect).toBe("ask");
  });

  it("applies at every level by default, so a hard limit stops an ask too, and minLevel still narrows it", () => {
    expect(evaluateRule(sends, input({}, { level: 1, usage: { sends: 20 } }), t0)?.effect).toBe("deny");
    expect(evaluateRule({ ...sends, minLevel: 3 }, input({}, { level: 1, usage: { sends: 20 } }), t0)).toBeNull();
  });

  it("only applies to its actions, and a budget with no limits does nothing", () => {
    expect(evaluateRule(sends, input({}, { action: "doc.draft", usage: { sends: 99 } }), t0)).toBeNull();
    expect(evaluateRule({ type: "budget", id: "x", per: "agent", windowMs: HOUR }, input({}, { usage: { x: 99 } }), t0)).toBeNull();
  });

  it("uses the builder's message when there is one", () => {
    expect(evaluateRule({ ...sends, message: "That's my send limit for the hour." }, input({}, { usage: { sends: 20 } }), t0)?.message).toBe(
      "That's my send limit for the hour.",
    );
  });

  it("names odd windows plainly", () => {
    const at = (windowMs: number) => evaluateRule({ ...sends, windowMs }, input({}, { usage: { sends: 20 } }), t0)?.detail;
    expect(at(60_000)).toMatch(/per minute$/);
    expect(at(15 * 60_000)).toMatch(/per 15 minutes$/);
    expect(at(7 * DAY)).toMatch(/per 7 days$/);
    expect(at(1500)).toMatch(/per 1500ms$/);
  });

  it("budgetsFor lists the budgets an action needs counts for", () => {
    const rules = [sends, spend, { type: "dormancy" as const, afterMs: DAY }];
    expect(budgetsFor(rules, "email.send").map((b) => b.id)).toEqual(["sends", "spend"]);
    expect(budgetsFor(rules, "payment.send").map((b) => b.id)).toEqual(["spend"]);
    expect(budgetsFor(undefined, "email.send")).toEqual([]);
  });
});

describe("budgets in decide", () => {
  const config: Config = {
    version: "b1",
    actions: { "email.send": { key: "email.send", risk: "hard_to_reverse" }, "doc.draft": { key: "doc.draft", risk: "reversible_self", alwaysAsk: true } },
    rules: [sends, { ...sends, id: "drafts", actions: ["doc.*"], deny: 0, ask: undefined }],
  };
  const base = { agent: "a", subject: "u1", action: "email.send" };
  const earned = { ...newScope(t0, 3) };

  it("an earned L3 acts under the budget, asks over the soft limit, and is denied over the hard limit", () => {
    expect(decide(base, config, { trust: earned, usage: { sends: 3 } }, { now: t0 }).decision).toBe("allow");
    const soft = decide(base, config, { trust: earned, usage: { sends: 10 } }, { now: t0 });
    expect(soft).toMatchObject({ decision: "ask", binding: "budget:sends", level: 1, next: "approve" });
    const hard = decide(base, config, { trust: earned, usage: { sends: 20 } }, { now: t0 });
    expect(hard).toMatchObject({ decision: "deny", binding: "budget:sends", level: 0, next: "none" });
    expect(hard.chain.find((s) => s.step === "tripwire")).toMatchObject({ result: "deny", id: "budget:sends" });
  });

  it("the earned level is untouched, and the hard limit wins over an always-ask class", () => {
    const hard = decide(base, config, { trust: earned, usage: { sends: 20 } }, { now: t0 });
    expect(hard.levels.earned).toBe(3);
    const draft = decide({ ...base, action: "doc.draft" }, config, { usage: { drafts: 0 } }, { now: t0 });
    expect(draft).toMatchObject({ decision: "deny", binding: "budget:drafts" });
  });

  it("a new subject at L1 is denied at the hard limit rather than asked", () => {
    expect(decide(base, config, { usage: { sends: 20 } }, { now: t0 })).toMatchObject({ decision: "deny", binding: "budget:sends" });
    expect(decide(base, config, { usage: { sends: 0 } }, { now: t0 })).toMatchObject({ decision: "ask", binding: expect.not.stringMatching(/^budget/) });
  });
});
