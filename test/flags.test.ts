import { describe, expect, it } from "vitest";
import { evaluateFlag, type Flag } from "../src/index.js";

const ctx = (key: string, extra: Record<string, unknown> = {}) => ({ subject: { key, ...extra } });

const gate: Flag<number | false> = {
  key: "inbox-send",
  on: true,
  variations: [false, 1, 3],
  offVariation: 0,
  rules: [{ id: "staff", when: [{ kind: "subject", attr: "staff", op: "eq", values: [true] }], serve: { variation: 2 } }],
  fallthrough: { rollout: { variations: [{ variation: 2, weight: 20 }, { variation: 0, weight: 80 }] } },
};

describe("evaluateFlag", () => {
  it("serves the off variation when off", () => {
    expect(evaluateFlag({ ...gate, on: false }, ctx("a"))).toMatchObject({ value: false, reason: { kind: "OFF" } });
  });

  it("matches rules in order", () => {
    expect(evaluateFlag(gate, ctx("a", { staff: true }))).toMatchObject({
      value: 3,
      reason: { kind: "RULE_MATCH", ruleId: "staff", ruleIndex: 0, inRollout: false },
    });
  });

  it("splits the fallthrough by percentage, deterministically", () => {
    let on = 0;
    for (let i = 0; i < 5000; i++) {
      const r = evaluateFlag(gate, ctx(`u${i}`));
      expect(r.reason).toEqual({ kind: "FALLTHROUGH", inRollout: true });
      if (r.value === 3) on++;
      expect(evaluateFlag(gate, ctx(`u${i}`)).value).toBe(r.value);
    }
    expect(on / 5000).toBeGreaterThan(0.17);
    expect(on / 5000).toBeLessThan(0.23);
  });

  it("checks prerequisites", () => {
    const parent: Flag<boolean> = { key: "parent", on: true, variations: [false, true], offVariation: 0, fallthrough: { variation: 0 } };
    const child: Flag<boolean> = {
      key: "child",
      on: true,
      variations: [false, true],
      offVariation: 0,
      fallthrough: { variation: 1 },
      prerequisites: [{ key: "parent", variation: 1 }],
    };
    expect(evaluateFlag(child, ctx("a"), { flags: { parent } }).reason).toEqual({ kind: "PREREQUISITE_FAILED", prerequisite: "parent" });
    const parentOn = { ...parent, fallthrough: { variation: 1 } };
    expect(evaluateFlag(child, ctx("a"), { flags: { parent: parentOn } }).value).toBe(true);
    expect(evaluateFlag(child, ctx("a"), { flags: {} }).reason.kind).toBe("PREREQUISITE_FAILED");
  });

  it("detects prerequisite cycles", () => {
    const a: Flag<boolean> = { key: "a", on: true, variations: [false, true], offVariation: 0, fallthrough: { variation: 1 }, prerequisites: [{ key: "b", variation: 1 }] };
    const b: Flag<boolean> = { ...a, key: "b", prerequisites: [{ key: "a", variation: 1 }] };
    expect(evaluateFlag(a, ctx("x"), { flags: { a, b } }).reason).toEqual({ kind: "ERROR", error: "PREREQUISITE_CYCLE" });
  });

  it("reports malformed variations instead of throwing", () => {
    const bad: Flag<boolean> = { key: "bad", on: true, variations: [true], offVariation: 0, fallthrough: { variation: 4 } };
    expect(evaluateFlag(bad, ctx("x")).reason).toEqual({ kind: "ERROR", error: "MALFORMED_FLAG" });
  });

  it("serves the first variation without a bucketing key", () => {
    expect(evaluateFlag(gate, { agent: { key: "x" } })).toMatchObject({ value: 3, reason: { kind: "FALLTHROUGH", inRollout: false } });
  });
});
