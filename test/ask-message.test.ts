import { describe, expect, it } from "vitest";
import { decide, newScope, type Config } from "../src/index.js";

const now = 1_700_000_000_000;
const config: Config = {
  version: "cfg_ask",
  actions: {
    "email.send": { key: "email.send", risk: "hard_to_reverse", askMessage: "Can I send this email?" },
    "email.send.bulk": { key: "email.send.bulk", risk: "hard_to_reverse", askMessage: "Can I send this email?", alwaysAsk: "bulk_send" },
    "doc.share": { key: "doc.share", risk: "reversible_shared", askMessage: "   " },
    "doc.draft": { key: "doc.draft", risk: "reversible_self", askMessage: "Can I draft this?" },
    "payment.send": { key: "payment.send", risk: "irreversible" },
  },
};
const ask = (action: string) => decide({ agent: "a", subject: "s", action }, config, {}, { now });

describe("askMessage, what the agent says when it asks", () => {
  it("is what an L1 ask says for that action", () => {
    const d = ask("email.send");
    expect([d.decision, d.level, d.message]).toEqual(["ask", 1, "Can I send this email?"]);
  });

  it("defaults to Can I do this? when the action has none, or only spaces", () => {
    expect(ask("payment.send").message).toBe("Can I do this?");
    expect(ask("doc.share").message).toBe("Can I do this?");
  });

  it("doesn't replace an always-ask reason", () => {
    const d = ask("email.send.bulk");
    expect(d.decision).toBe("ask");
    expect(d.message).not.toBe("Can I send this email?");
  });

  it("isn't used when the action goes ahead", () => {
    const trust = { ...newScope(now - 100 * 3_600_000, 3), lastActivity: now - 3_600_000 };
    const d = decide({ agent: "a", subject: "s", action: "doc.draft" }, config, { trust }, { now });
    expect(d.decision).toBe("allow");
    expect(d.message).not.toContain("Can I draft this?");
  });

  it("isn't used for an action the config doesn't know", () => {
    expect(ask("crm.update").message).toContain("crm.update");
  });
});
