// The cases behind conformance/vectors.json. Inputs only. The expected outputs are what this engine
// returns, written by `UPDATE_CONFORMANCE=1 npx vitest run packages/core/test/conformance.test.ts`.
// Every case must be plain JSON (no functions, Sets or undefined that matters), so another
// implementation can load the file and check itself without TypeScript.
import { COMMS_PACK, DEFAULT_PACK, type Config, type DecideInput, type DecideState, type Level, type Outcome, type TrustScope } from "../src/index.js";

export const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const base: Config = {
  version: "cfg_conformance_1",
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
  experiments: [{ key: "auto-accept", status: "running", traffic: 100, actions: ["calendar.*"], arms: [{ key: "capped", weight: 100, autonomyCap: 1 }] }],
  policies: [{ id: "no-minors", effect: "forbid", actions: ["payment.*"], when: [{ kind: "subject", attr: "age", op: "lt", values: [18] }] }],
  rules: [...DEFAULT_PACK.rules, ...COMMS_PACK.rules.filter((r) => r.type === "novelty")],
};

const pro = { plan: "pro", status: "active" as const };
const scope = (earned: Level, extra: Partial<TrustScope> = {}): TrustScope => ({
  earned,
  levelSince: NOW - 100 * HOUR,
  lastActivity: NOW - HOUR,
  stats: { responses: 0, approved: 0, edited: 0, rejected: 0, undone: 0, weightedApproved: 0 },
  recent: [],
  envelope: { to: { values: ["a@x.com"] } },
  sinceCheck: 0,
  ...extra,
});
const approvedRun = (n: number): TrustScope => ({
  earned: 1,
  levelSince: NOW - 2 * HOUR,
  lastActivity: NOW - HOUR,
  stats: { responses: n, approved: n, edited: 0, rejected: 0, undone: 0, weightedApproved: n },
  recent: Array.from({ length: n }, () => "approved" as Outcome),
  envelope: {},
  sinceCheck: 0,
});

/** Named configs, so the JSON holds each once. A case names the one it runs against. */
export const CONFIGS: Record<string, Config> = {
  base,
  killedDocs: { ...base, killed: ["doc.*"] },
  killedEmail: { ...base, killed: ["email.*"] },
  emailHeadsUp: { ...base, actions: { ...base.actions, "email.send": { ...base.actions["email.send"]!, levels: [0, 1, 2, 3, 4] } } },
  emailFullRollout: { ...base, flags: { "email-send": { ...base.flags!["email-send"]!, fallthrough: { variation: 2 } } } },
  draftNeedsEmail: { ...base, actions: { ...base.actions, "doc.draft": { key: "doc.draft", risk: "reversible_self", feature: "email" } } },
  proPaymentsUncapped: { ...base, plans: { pro: { key: "pro", features: { payments: true } } } },
  budgets: {
    ...base,
    rules: [
      { type: "budget", id: "drafts", per: "subject", windowMs: HOUR, actions: ["doc.*"], ask: 10, deny: 20 },
      { type: "budget", id: "spend", per: "project", windowMs: DAY, actions: ["payment.*"], field: "amount", ask: 100, deny: 500 },
    ],
  },
};

export interface DecideCase {
  name: string;
  input: DecideInput;
  /** A key of CONFIGS. */
  config: string;
  state: DecideState;
  options: { now: number; id: string };
}

const c = (name: string, input: Partial<DecideInput>, state: DecideState = {}, config = "base"): DecideCase => ({
  name,
  input: { agent: "inbox", subject: "u1", action: "doc.draft", ...input },
  config,
  state,
  options: { now: NOW, id: "dec_conformance" },
});

export const DECIDE_CASES: DecideCase[] = [
  // Earned trust
  c("a new scope asks at L1", {}),
  c("an earned L3 acts and says so", {}, { trust: scope(3) }),
  c("an earned L5 on a reversible action acts alone", {}, { trust: scope(5) }),
  c("a manual cap from the human holds it at ask", {}, { trust: scope(5, { userCap: 1 }) }),
  c("enough clean approvals offer a promotion", {}, { trust: approvedRun(6) }),
  // Hard limits, in the decision order
  c("a kill switch denies", {}, { trust: scope(5) }, "killedDocs"),
  c("a forbid policy denies", { action: "payment.send", subject: { key: "kid", age: 12 } }, { subscription: pro, trust: scope(5) }),
  c("a plan without the feature denies with an upgrade path", { action: "email.send" }, { subscription: { plan: "free", status: "active" }, trust: scope(5) }),
  c("a gate rule serving off denies for that subject", { action: "email.send", subject: { key: "u2", blocked: true } }, { subscription: pro, trust: scope(5) }),
  c("a kill switch beats a lapsed plan's forced ask", { action: "email.send" }, { subscription: { plan: "pro", status: "lapsed" } }, "killedEmail"),
  // Ceilings, rollouts and experiments
  c("action classes resolve hierarchically", { action: "email.reply" }, { subscription: pro, trust: scope(5) }),
  c("the plan ceiling for a risk class binds", { action: "payment.send", context: { amount: 10 } }, { subscription: pro, trust: scope(5) }),
  c("the gate's rollout variation caps the level", { action: "email.send", context: { to: "a@x.com" } }, { subscription: pro, trust: scope(4) }),
  c(
    "a heads up where the action supports L2",
    { action: "email.send", context: { to: "a@x.com" } },
    { subscription: pro, trust: scope(4) },
    "emailHeadsUp",
  ),
  c(
    "hard to reverse reaches its L3 risk ceiling",
    { action: "email.send", context: { to: "a@x.com" } },
    { subscription: pro, trust: scope(4) },
    "emailFullRollout",
  ),
  c("an experiment arm caps autonomy and records exposure", { action: "calendar.accept" }, { trust: scope(4) }),
  c("an always-ask class asks at any level", { action: "account.close" }, { trust: scope(5) }),
  c(
    "a lapsed subscriber is asked for low-risk work, by declared policy",
    {},
    { subscription: { plan: "pro", status: "lapsed" }, trust: scope(5) },
    "draftNeedsEmail",
  ),
  // Budgets. The host supplies what was spent in the window before this call.
  c("under a budget the earned level acts", {}, { trust: scope(5), usage: { drafts: 5 } }, "budgets"),
  c("past a budget's soft limit asks", {}, { trust: scope(5), usage: { drafts: 10 } }, "budgets"),
  c("past a budget's hard limit denies, even a subject still at ask", {}, { usage: { drafts: 20 } }, "budgets"),
  c("a cost budget adds this call's cost", { action: "payment.send", context: { amount: 60 } }, { subscription: pro, trust: scope(2), usage: { spend: 50 } }, "budgets"),
  c("a budget with no usage supplied asks", {}, { trust: scope(5) }, "budgets"),
  // Tripwires
  c("a new recipient drops one call to ask", { action: "email.send", context: { to: "new@x.com" } }, { subscription: pro, trust: scope(3) }),
  c(
    "an irreversible action is capped to a heads up",
    { action: "payment.send", context: { amount: 5 } },
    { subscription: pro, trust: scope(4) },
    "proPaymentsUncapped",
  ),
  c(
    "low confidence asks, and an ask beats a cap",
    { action: "payment.send", context: { confidence: 0.2 } },
    { subscription: pro, trust: scope(4) },
    "proPaymentsUncapped",
  ),
  c("a model change asks (drift)", { context: { model: "m2" } }, { trust: scope(4, { fingerprint: { model: "m1" } }) }),
  // Failing safe
  c("an unknown action asks and says what's missing", { action: "docs.read" }, { trust: scope(5) }),
  c("a missing subject asks and says so", { subject: "" }, { trust: scope(5) }),
  c("a missing gate caps to ask", { action: "legacy.thing" }, { trust: scope(5) }),
  c("corrupt trust state asks", {}, { trust: scope(3, { earned: 9 as never }) }),
];

export interface RecordCase {
  name: string;
  scope: TrustScope;
  /** Applied in order. Each step's scope feeds the next. */
  steps: { outcome: Outcome; options: { level: Level; now: number; supported?: Level[]; tripwire?: boolean; responseMs?: number } }[];
}

const fresh = (): TrustScope => ({ ...scope(1), envelope: {}, levelSince: NOW - 2 * DAY, lastActivity: NOW - 2 * DAY });
const at = (n: number, outcome: Outcome, level: Level = 1, extra: Partial<RecordCase["steps"][number]["options"]> = {}) => ({
  outcome,
  options: { level, now: NOW + n * HOUR, ...extra },
});

export const RECORD_CASES: RecordCase[] = [
  { name: "approvals count toward promotion", scope: fresh(), steps: [1, 2, 3, 4, 5].map((n) => at(n, "approved")) },
  { name: "an edit counts as half a rejection", scope: fresh(), steps: [at(1, "approved"), at(2, "edited"), at(3, "approved")] },
  { name: "a rushed approval is weighted at half", scope: fresh(), steps: [at(1, "approved", 1, { responseMs: 400 }), at(2, "approved", 1, { responseMs: 30_000 })] },
  { name: "an undo at L3 drops one level", scope: scope(3), steps: [at(1, "undone", 3)] },
  { name: "a rejection at L1 doesn't demote", scope: fresh(), steps: [at(1, "rejected")] },
  { name: "a demotion lands on a supported level", scope: scope(3), steps: [at(1, "rejected", 3, { supported: [0, 1, 3, 4] })] },
  { name: "repeated rejected tripwire asks demote", scope: scope(4), steps: [1, 2, 3].map((n) => at(n, "rejected", 1, { tripwire: true })) },
  { name: "silence counts as consent only at L2, and expired never counts", scope: scope(2), steps: [at(1, "ignored", 2), at(2, "expired", 2)] },
];

/** Published bucketing vectors (SPEC.md, Bucketing). Same as test/hash.test.ts. */
export const BUCKET_CASES: { salt: string; key: string }[] = [
  { salt: "checkout", key: "user_1" },
  { salt: "checkout", key: "user_2" },
  { salt: "inbox-send", key: "user_123" },
  { salt: "", key: "" },
  { salt: "email-send:traffic", key: "u1" },
  { salt: "日本", key: "🚀 go" },
];
