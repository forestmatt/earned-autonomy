import { describe, expect, it } from "vitest";
import { DEFAULT_PACK, COMMS_PACK, decide, newScope, recordOutcome, type Config, type TrustScope } from "../src/index.js";

const now = 1_700_000_000_000;
const HOUR = 3_600_000;

const config: Config = {
  version: "cfg_1",
  actions: {
    "doc.draft": { key: "doc.draft", risk: "reversible_self" },
    email: { key: "email", risk: "hard_to_reverse", feature: "email" },
    "email.send": { key: "email.send", risk: "hard_to_reverse", feature: "email", gate: "email-send" },
    "calendar.accept": { key: "calendar.accept", risk: "reversible_shared" },
    "payment.send": { key: "payment.send", risk: "irreversible", feature: "payments", ceiling: 4 },
    "account.close": { key: "account.close", risk: "irreversible", alwaysAsk: "account_closure" },
    "legacy.thing": { key: "legacy.thing", risk: "reversible_self", gate: "missing-gate" },
  },
  flags: {
    "email-send": {
      key: "email-send",
      on: true,
      variations: [false, 2, 5],
      offVariation: 0,
      rules: [{ id: "blocked", when: [{ kind: "subject", attr: "blocked", op: "eq", values: [true] }], serve: { variation: 0 } }],
      fallthrough: { variation: 1 },
    },
  },
  plans: {
    free: { key: "free", features: { email: false } },
    pro: { key: "pro", features: { email: true, payments: true }, ceilings: { irreversible: 2 } },
  },
  experiments: [
    { key: "auto-accept", status: "running", traffic: 100, actions: ["calendar.*"], arms: [{ key: "capped", weight: 100, autonomyCap: 1 }] },
  ],
  policies: [{ id: "no-minors", effect: "forbid", actions: ["payment.*"], when: [{ kind: "subject", attr: "age", op: "lt", values: [18] }] }],
  rules: [...DEFAULT_PACK.rules, ...COMMS_PACK.rules.filter((r) => r.type === "novelty")],
};

const pro = { plan: "pro", status: "active" as const };
const trusted = (earned: 0 | 1 | 2 | 3 | 4 | 5, extra: Partial<TrustScope> = {}): TrustScope => ({
  ...newScope(now - 100 * HOUR, earned),
  envelope: { to: { values: ["a@x.com"] } },
  lastActivity: now - HOUR,
  ...extra,
});
const run = (input: Partial<Parameters<typeof decide>[0]>, state: Parameters<typeof decide>[2] = {}, cfg: Config = config) =>
  decide({ agent: "inbox", subject: "u1", action: "doc.draft", ...input }, cfg, state, { now, id: "dec_test" });

describe("decide", () => {
  it("asks a new scope at L1, with a full reason chain", () => {
    const d = run({});
    expect(d).toMatchObject({
      id: "dec_test",
      decision: "ask",
      level: 1,
      mode: "ask",
      binding: "earned:L1",
      levels: { earned: 1, ceiling: 5, rollout: 5, experiment: 5 },
      next: "approve",
      fallback: false,
      configVersion: "cfg_1",
    });
    expect(d.chain.map((c) => c.step)).toEqual(["health", "policy", "entitlement", "rollout", "experiment", "effective", "mode"]);
  });

  it("allows an earned L3 and says so", () => {
    const d = run({}, { trust: trusted(3) });
    expect(d).toMatchObject({ decision: "allow", level: 3, mode: "act_and_tell", binding: "earned:L3", next: "none" });
  });

  it("allows L2 with a delay", () => {
    const d = run({ action: "email.send", context: { to: "a@x.com" } }, { subscription: pro, trust: trusted(4) });
    expect(d).toMatchObject({ decision: "allow", level: 2, mode: "heads_up", binding: "rollout:email-send", next: "wait", delaySeconds: 600 });
    expect(d.message).toContain("unless you stop me");
  });

  it("is deterministic for the same inputs", () => {
    const a = decide({ agent: "a", subject: "s", action: "doc.draft" }, config, {}, { now });
    const b = decide({ agent: "a", subject: "s", action: "doc.draft" }, config, {}, { now });
    expect(a).toEqual(b);
    expect(a.id).toMatch(/^dec_/);
  });

  describe("deny wins", () => {
    it("kill switch", () => {
      expect(run({}, {}, { ...config, killed: ["doc.*"] })).toMatchObject({ decision: "deny", binding: "policy:kill_switch" });
    });

    it("policy forbid", () => {
      const d = run({ action: "payment.send", subject: { key: "kid", age: 12 } }, { subscription: pro, trust: trusted(5) });
      expect(d).toMatchObject({ decision: "deny", binding: "policy:no-minors" });
    });

    it("entitlement, with an upgrade path", () => {
      const d = run({ action: "email.send" }, { subscription: { plan: "free", status: "active" }, trust: trusted(5) });
      expect(d).toMatchObject({ decision: "deny", binding: "entitlement:email", next: "upgrade" });
    });

    it("gate off for this subject", () => {
      const d = run({ action: "email.send", subject: { key: "u2", blocked: true } }, { subscription: pro, trust: trusted(5) });
      expect(d).toMatchObject({ decision: "deny", binding: "rollout:email-send" });
    });

    it("deny beats a forced ask from a lapsed plan", () => {
      const cfg: Config = { ...config, killed: ["email.*"] };
      expect(run({ action: "email.send" }, { subscription: { plan: "pro", status: "lapsed" } }, cfg).decision).toBe("deny");
    });
  });

  it("resolves action classes hierarchically", () => {
    const d = run({ action: "email.reply" }, { subscription: pro, trust: trusted(5) });
    expect(d.chain[0]!.detail).toBe("action class email");
    expect(d.levels.ceiling).toBe(3);
  });

  it("takes the plan ceiling for the risk class", () => {
    const d = run({ action: "payment.send", context: { amount: 10 } }, { subscription: pro, trust: trusted(5) });
    expect(d).toMatchObject({ level: 2, binding: "ceiling:plan/pro", levels: { ceiling: 2 } });
  });

  it("caps by experiment arm and records exposure", () => {
    const d = run({ action: "calendar.accept" }, { trust: trusted(4) });
    expect(d).toMatchObject({ decision: "ask", binding: "experiment:auto-accept/capped", exposures: [{ experiment: "auto-accept", arm: "capped" }] });
  });

  it("forces an ask for always-ask classes", () => {
    const d = run({ action: "account.close" }, { trust: trusted(5) });
    expect(d).toMatchObject({ decision: "ask", binding: "forced:account_closure", level: 1 });
  });

  it("asks used-to-pay subscribers for low-risk work, by declared policy", () => {
    const cfg: Config = { ...config, actions: { ...config.actions, "doc.draft": { key: "doc.draft", risk: "reversible_self", feature: "email" } } };
    const d = run({}, { subscription: { plan: "pro", status: "lapsed" }, trust: trusted(5) }, cfg);
    expect(d).toMatchObject({ decision: "ask", binding: "entitlement:lapsed/email", next: "upgrade" });
  });

  it("honours a manual cap from the human", () => {
    expect(run({}, { trust: trusted(5, { userCap: 1 }) })).toMatchObject({ decision: "ask", binding: "ceiling:user" });
  });

  describe("tripwires", () => {
    it("drop one call to ask without touching the earned level", () => {
      const d = run({ action: "email.send", context: { to: "new@x.com" } }, { subscription: pro, trust: trusted(3) });
      expect(d).toMatchObject({ decision: "ask", level: 1, binding: "tripwire:novelty", levels: { earned: 3 } });
      expect(d.message).toContain("new recipient");
    });

    it("cap irreversible actions to a heads up", () => {
      const cfg: Config = { ...config, plans: { pro: { key: "pro", features: { payments: true } } } };
      const d = run({ action: "payment.send", context: { amount: 5 } }, { subscription: pro, trust: trusted(4) }, cfg);
      expect(d).toMatchObject({ decision: "allow", level: 2, binding: "tripwire:irreversible", delaySeconds: 600 });
    });

    it("an ask beats a cap", () => {
      const cfg: Config = { ...config, plans: { pro: { key: "pro", features: { payments: true } } } };
      const d = run({ action: "payment.send", context: { confidence: 0.2 } }, { subscription: pro, trust: trusted(4) }, cfg);
      expect(d).toMatchObject({ decision: "ask", binding: "tripwire:confidence" });
    });

    it("drift asks after a model change", () => {
      const d = run({ context: { model: "m2" } }, { trust: trusted(4, { fingerprint: { model: "m1" } }) });
      expect(d.binding).toBe("tripwire:drift");
    });
  });

  it("offers promotion when the evidence is there (fatigue as a trigger)", () => {
    let trust = newScope(now - 2 * HOUR);
    for (let i = 0; i < 6; i++) trust = recordOutcome(trust, "approved", { level: 1, now: now - HOUR }).scope;
    const d = run({}, { trust });
    expect(d).toMatchObject({ decision: "ask", next: "request_promotion" });
    expect(d.message).toContain("You've approved the last 6");
  });

  describe("never throws, never defaults to allow", () => {
    it.each([
      ["no config", { agent: "a", subject: "s", action: "doc.draft" }, null, "error:no_config"],
      ["missing subject", { agent: "a", subject: "", action: "doc.draft" }, config, "error:invalid_context"],
      ["missing agent", { subject: "s", action: "doc.draft" }, config, "error:invalid_context"],
      ["unknown action", { agent: "a", subject: "s", action: "nope.nothing" }, config, "error:unknown_action"],
    ])("%s", (_, input, cfg, binding) => {
      const d = decide(input as never, cfg as never, {}, { now });
      expect(d).toMatchObject({ decision: "ask", binding, fallback: true });
    });

    it("a missing gate caps to ask", () => {
      expect(run({ action: "legacy.thing" }, { trust: trusted(5) })).toMatchObject({ decision: "ask", binding: "error:gate_not_found" });
    });

    it("an exception inside evaluation", () => {
      const cfg = { ...config, rules: [{ type: "novelty", field: "to", get actions(): string[] { throw new Error("boom"); } }] } as never;
      expect(run({}, { trust: trusted(3) }, cfg)).toMatchObject({ decision: "ask", binding: "error:internal", fallback: true });
    });

    it("corrupt trust state", () => {
      expect(run({}, { trust: { ...trusted(3), earned: 9 as never } })).toMatchObject({ decision: "ask", binding: "error:invalid_trust" });
    });
  });
});

describe("hard to reverse is not irreversible", () => {
  it("reaches its L3 ceiling under the Default pack", () => {
    const cfg: Config = { ...config, flags: { "email-send": { ...config.flags!["email-send"]!, fallthrough: { variation: 2 } } } };
    const d = run({ action: "email.send", context: { to: "a@x.com" } }, { subscription: pro, trust: trusted(4) }, cfg);
    expect(d).toMatchObject({ decision: "allow", level: 3, binding: "ceiling:risk/hard_to_reverse" });
  });
});
