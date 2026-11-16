import { describe, expect, it } from "vitest";
import { decide, resolveActionClass, type Config } from "../src/index.js";

const base: Config = {
  version: "t",
  actions: {
    "email.send": { key: "email.send", risk: "hard_to_reverse" },
    "*": { key: "*", risk: "hard_to_reverse", description: "Anything not listed" },
  },
};
const ctx = { agent: "a", subject: "u" };

describe("the * catch-all action class", () => {
  it("is used for unknown actions, under the action's own key", () => {
    expect(resolveActionClass(base, "crm.update")).toMatchObject({ key: "crm.update", risk: "hard_to_reverse" });
    expect(resolveActionClass(base, "email.send.bulk")?.key).toBe("email.send");
  });

  it("asks for an unknown action with a real decision, not a fallback", () => {
    const d = decide({ action: "crm.update", ...ctx }, base, {}, { now: 0, id: "d1" });
    expect(d.fallback).toBe(false);
    expect(d.decision).toBe("ask");
  });

  it("without *, unknown actions are still a fallback ask", () => {
    const { "*": _, ...actions } = base.actions;
    const d = decide({ action: "crm.update", ...ctx }, { ...base, actions }, {}, { now: 0, id: "d1" });
    expect(d.fallback).toBe(true);
    expect(d.decision).toBe("ask");
  });

  it("an action called * or a prototype name never resolves to something it isn't", () => {
    const { "*": _, ...actions } = base.actions;
    const plain = { ...base, actions };
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "*"]) expect(resolveActionClass(plain, name)).toBeUndefined();
    expect(resolveActionClass(base, "constructor")?.key).toBe("constructor");
  });
});

describe("prototype names from callers", () => {
  it("a gate, prerequisite or plan called constructor is treated as missing", () => {
    const cfg: Config = { version: "t", actions: { "a.b": { key: "a.b", risk: "reversible_self", gate: "constructor" } } };
    const d = decide({ agent: "a", subject: "u", action: "a.b" }, cfg, {}, { now: 0, id: "d" });
    expect(d.decision).not.toBe("allow");
    expect(d.chain.some((c) => c.id === "error:gate_not_found")).toBe(true);
  });
});
