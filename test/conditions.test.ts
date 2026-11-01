import { describe, expect, it } from "vitest";
import { actionMatches, conditionMatches, type Condition, type EvalContext } from "../src/index.js";

const ctx: EvalContext = {
  subject: { key: "u1", country: "GB", age: 30, tags: ["beta", "staff"], org: { tier: "gold" } },
  agent: { key: "inbox" },
};

describe("conditions", () => {
  it.each([
    [{ kind: "subject", attr: "country", op: "eq", values: ["GB"] }, true],
    [{ kind: "subject", attr: "country", op: "in", values: ["US", "GB"] }, true],
    [{ kind: "subject", attr: "country", op: "notIn", values: ["GB"] }, false],
    [{ kind: "subject", attr: "age", op: "gte", values: [30] }, true],
    [{ kind: "subject", attr: "age", op: "gt", values: [30] }, false],
    [{ kind: "subject", attr: "age", op: "lt", values: ["40"] }, false],
    [{ kind: "subject", attr: "tags", op: "in", values: ["beta"] }, true],
    [{ kind: "subject", attr: "org.tier", op: "eq", values: ["gold"] }, true],
    [{ kind: "subject", attr: "key", op: "startsWith", values: ["u"] }, true],
    [{ kind: "subject", attr: "missing", op: "missing" }, true],
    [{ kind: "resource", attr: "key", op: "exists" }, false],
    [{ kind: "agent", attr: "key", op: "contains", values: ["box"] }, true],
  ] as [Condition, boolean][])("%j is %s", (c, expected) => {
    expect(conditionMatches(c, ctx)).toBe(expected);
  });

  it("matches segments by membership and rules", () => {
    const env = {
      segments: {
        staff: { key: "staff", rules: [{ kind: "subject", attr: "tags", op: "in" as const, values: ["staff"] }] },
        vip: { key: "vip", included: ["subject:u9"] },
        nobody: { key: "nobody", excluded: ["subject:u1"], rules: [{ kind: "subject", attr: "age", op: "gt" as const, values: [1] }] },
      },
    };
    expect(conditionMatches({ kind: "subject", attr: "key", op: "segment", values: ["staff"] }, ctx, env)).toBe(true);
    expect(conditionMatches({ kind: "subject", attr: "key", op: "segment", values: ["vip"] }, ctx, env)).toBe(false);
    expect(conditionMatches({ kind: "subject", attr: "key", op: "segment", values: ["nobody"] }, ctx, env)).toBe(false);
    expect(conditionMatches({ kind: "subject", attr: "key", op: "notSegment", values: ["vip"] }, ctx, env)).toBe(true);
  });

  it("matches action patterns", () => {
    expect(actionMatches("email.*", "email.send")).toBe(true);
    expect(actionMatches("email.*", "email")).toBe(true);
    expect(actionMatches("email.*", "emails.send")).toBe(false);
    expect(actionMatches("*", "x")).toBe(true);
    expect(actionMatches("email.send", "email.send.bulk")).toBe(false);
  });
});
