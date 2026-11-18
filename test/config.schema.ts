import { z } from "zod";

// The source of conformance/config.schema.json. It mirrors `Config` field for field, and
// config-schema.test.ts fails to typecheck if the two drift, so a new config field needs a line here.
// zod is a dev dependency only. The engine itself never validates with it (decide never throws).

const level = z.literal([0, 1, 2, 3, 4, 5]).describe("Autonomy level, L0 (suggest) to L5 (autonomous).");
const risk = z
  .enum(["reversible_self", "reversible_shared", "hard_to_reverse", "irreversible", "regulated"])
  .describe("Risk class, least to most risky. Each has a default ceiling and promotion thresholds.");
const ms = z.number().int().nonnegative();
const percent = z.number().min(0).max(100);
const patterns = z.array(z.string()).describe("Action patterns, for example `email.*`. Omitted means all.");

const condition = z
  .strictObject({
    kind: z.string().describe("Context kind, for example `subject`, `agent`, `context` or a custom kind."),
    attr: z.string().describe("Attribute name. `key` targets the entity key."),
    op: z.enum(["eq", "neq", "in", "notIn", "gt", "gte", "lt", "lte", "exists", "missing", "startsWith", "endsWith", "contains", "segment", "notSegment"]),
    values: z.array(z.unknown()).optional().describe("For `segment` and `notSegment`, segment keys."),
  })
  .describe("A targeting condition on one context kind.");

const segment = z.strictObject({
  key: z.string(),
  included: z.array(z.string()).optional().describe("Members as `kind:key`, for example `subject:user_1`."),
  excluded: z.array(z.string()).optional(),
  rules: z.array(condition).optional().describe("All must match."),
});

const thresholds = z.strictObject({
  minApprovals: z.number().int().nonnegative().nullable().describe("Attention-weighted approvals needed at the current level. null means manual only."),
  minRate: z.number().min(0).max(1).describe("(approved + 0.5 * edited) / responses."),
  cleanRun: z.number().int().nonnegative().describe("No rejection or undo in this many most recent outcomes."),
  minDwellMs: ms.describe("Minimum time at the current level."),
  declineCooldownMs: ms.describe("After a declined offer, wait this long before offering again."),
  requiresSigned: z.boolean().optional().describe("Promotion past Ask needs signed approvals."),
});
const partialThresholds = thresholds.partial();

const lapsedRule = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("deny") }),
  z.strictObject({ outcome: z.literal("ask") }),
  z.strictObject({ outcome: z.literal("cap"), level }),
]);

const actionClass = z
  .strictObject({
    key: z.string().min(1),
    risk,
    reversible: z.boolean().optional().describe("Defaults to true, except for irreversible and regulated."),
    ceiling: level.optional().describe("Overrides the risk class's default ceiling."),
    levels: z.array(level).optional().describe("Levels this action supports. L0 and L1 are always included. Decisions round down."),
    feature: z.string().optional().describe("Plan feature that must be included."),
    gate: z.string().optional().describe("Key of a gate flag (variations are a level or false) that rolls this action out."),
    alwaysAsk: z.union([z.boolean(), z.string()]).optional().describe("Always ask, whatever the level. A string gives the reason."),
    lapsed: lapsedRule.optional().describe("Overrides the lapsed-subscriber policy for this class."),
    askMessage: z.string().optional().describe("What the agent says when it asks at L1. Defaults to \"Can I do this?\"."),
    delaySeconds: z.number().int().positive().optional().describe("The heads-up window at L2. Defaults to 600."),
    promotion: partialThresholds.optional().describe("Overrides promotion thresholds for this class, field by field."),
    description: z.string().optional(),
  })
  .describe("An action class, for example `email.send`. Keys are hierarchical, and `*` is the catch-all.");

const rollout = z.strictObject({
  variations: z.array(z.strictObject({ variation: z.number().int().nonnegative(), weight: percent })).describe("Weights are percentages and should sum to 100."),
  bucketBy: z.string().optional().describe("Context kind whose key is hashed. Defaults to `subject`."),
});
const serve = z.union([z.strictObject({ variation: z.number().int().nonnegative() }), z.strictObject({ rollout })]);

const flag = z
  .strictObject({
    key: z.string(),
    on: z.boolean(),
    variations: z.array(z.unknown()),
    offVariation: z.number().int().nonnegative(),
    fallthrough: serve,
    rules: z.array(z.strictObject({ id: z.string(), when: z.array(condition).optional(), serve })).optional(),
    prerequisites: z.array(z.strictObject({ key: z.string(), variation: z.number().int().nonnegative() })).optional(),
    salt: z.string().optional().describe("Salt for bucketing. Defaults to the key."),
    owner: z.string().optional(),
    lifetime: z.enum(["temporary", "permanent"]).optional(),
  })
  .describe("A typed flag. A gate is a flag whose variations are a level or false.");

const arm = z.strictObject({
  key: z.string(),
  weight: percent.describe("Percentage of assigned traffic. Weights should sum to 100."),
  autonomyCap: level.optional().describe("The most autonomy this arm allows. Omitted means no cap."),
  params: z.record(z.string(), z.unknown()).optional(),
});

const experiment = z.strictObject({
  key: z.string(),
  status: z.enum(["draft", "running", "stopped"]),
  arms: z.array(arm),
  traffic: percent.describe("Percentage of eligible subjects enrolled."),
  actions: patterns.optional(),
  when: z.array(condition).optional(),
  bucketBy: z.string().optional().describe("Context kind to randomise on. Defaults to `subject`."),
  salt: z.string().optional(),
  layer: z.string().optional().describe("Experiments in the same layer are mutually exclusive."),
});

const layer = z.strictObject({
  key: z.string(),
  allocations: z.array(z.strictObject({ experiment: z.string(), start: percent, end: percent })).describe("Bucket ranges as percentages, [start, end)."),
});

const holdout = z.strictObject({
  key: z.string(),
  percent,
  autonomyCap: level.optional().describe("Cap for held-out subjects. Omitted means no cap, just no experiments."),
  actions: patterns.optional(),
  bucketBy: z.string().optional(),
});

const plan = z.strictObject({
  key: z.string(),
  features: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
  ceilings: z.partialRecord(risk, level).optional().describe("Autonomy ceilings by risk class for subjects on this plan."),
});

const policy = z
  .strictObject({
    id: z.string(),
    effect: z.literal("forbid"),
    actions: patterns.optional(),
    when: z.array(condition).optional(),
    message: z.string().optional(),
  })
  .describe("Forbid wins over everything except a broken config.");

const ruleBase = { actions: patterns.optional(), minLevel: level.optional().describe("Only applies at or above this level. Defaults to L2.") };
const rule = z
  .discriminatedUnion("type", [
    z.strictObject({ ...ruleBase, type: z.literal("novelty"), field: z.string(), envelope: z.string().optional(), label: z.string().optional() }),
    z.strictObject({ ...ruleBase, type: z.literal("magnitude"), field: z.string(), max: z.number().optional(), envelopeFactor: z.number().optional(), useEnvelope: z.boolean().optional() }),
    z.strictObject({ ...ruleBase, type: z.literal("irreversible"), cap: level }),
    z.strictObject({ ...ruleBase, type: z.literal("drift"), fields: z.array(z.string()) }),
    z.strictObject({ ...ruleBase, type: z.literal("confidence"), field: z.string(), min: z.number() }),
    z.strictObject({ ...ruleBase, type: z.literal("untrusted_input"), field: z.string() }),
    z.strictObject({ ...ruleBase, type: z.literal("recheck"), every: z.number().int().positive() }),
    z.strictObject({ ...ruleBase, type: z.literal("dormancy"), afterMs: ms }),
  ])
  .describe("A layer 2 rule. Rules only lower a level or force an ask, never raise anything.");

export const configSchema = z
  .strictObject({
    $schema: z.string().optional().describe("Lets an editor find this schema. Ignored by the engine."),
    version: z.string().min(1).describe("Config version, echoed on every decision."),
    actions: z.record(z.string(), actionClass),
    flags: z.record(z.string(), flag).optional(),
    segments: z.record(z.string(), segment).optional(),
    experiments: z.array(experiment).optional(),
    layers: z.array(layer).optional(),
    holdouts: z.array(holdout).optional(),
    plans: z.record(z.string(), plan).optional(),
    lapsedPolicy: z.partialRecord(z.enum([...risk.options, "default"]), lapsedRule).optional().describe("What happens when the subscription that granted an action has lapsed."),
    policies: z.array(policy).optional(),
    killed: patterns.optional().describe("Kill switches. Action patterns denied for everyone."),
    rules: z.array(rule).optional(),
    promotion: z.partialRecord(risk, partialThresholds).optional().describe("Overrides the Default pack promotion thresholds per risk class, field by field."),
  })
  .meta({
    title: "earned-autonomy config",
    description: "Everything the earned-autonomy engine needs to decide allow, ask or deny. See SPEC.md.",
  });

export const SCHEMA_ID = "https://raw.githubusercontent.com/forestmatt/earned-autonomy/main/conformance/config.schema.json";

export function configJsonSchema(): Record<string, unknown> {
  const out = z.toJSONSchema(configSchema, { target: "draft-2020-12", io: "input", reused: "ref" }) as Record<string, unknown>;
  const { $schema, ...rest } = out;
  return { $schema, $id: SCHEMA_ID, ...rest };
}
