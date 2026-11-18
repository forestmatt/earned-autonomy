import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { RULE_PACKS, type Config } from "../src/index.js";
import { CONFIGS } from "./conformance.cases.js";
import { configJsonSchema, configSchema } from "./config.schema.js";

// conformance/config.schema.json, a JSON Schema (2020-12) for `Config`, so other implementations and
// editors can check a config without TypeScript. Made from test/config.schema.ts. Regenerate with
// `UPDATE_CONFORMANCE=1 npx vitest run packages/core/test/config-schema.test.ts`.

type Fs = { readFileSync(p: URL, enc: "utf8"): string; writeFileSync(p: URL, s: string): void };
const fs = (await import("node:" + "fs")) as Fs;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const file = new URL("../conformance/config.schema.json", import.meta.url);

const text = JSON.stringify(configJsonSchema(), null, 2) + "\n";
if (env.UPDATE_CONFORMANCE === "1") fs.writeFileSync(file, text);
const schema = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);

const ok = (c: unknown) => {
  const valid = validate(c);
  return { valid, errors: valid ? [] : validate.errors };
};

describe("config JSON schema", () => {
  it("matches the engine's Config type field for field (a compile error here means drift)", () => {
    expectTypeOf<Omit<z.output<typeof configSchema>, "$schema">>().toEqualTypeOf<Config>();
  });

  it("is what test/config.schema.ts generates (run with UPDATE_CONFORMANCE=1 to refresh)", () => {
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  it("compiles as strict draft 2020-12 and names itself", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toMatch(/earned-autonomy\/main\/conformance\/config\.schema\.json$/);
  });

  it("accepts every config in the conformance vectors", () => {
    const vectors = JSON.parse(fs.readFileSync(new URL("../conformance/vectors.json", import.meta.url), "utf8")) as { configs: Record<string, unknown> };
    expect(Object.keys(vectors.configs).length).toBeGreaterThan(3);
    for (const [name, c] of Object.entries(vectors.configs)) expect(ok(c), name).toEqual({ valid: true, errors: [] });
    for (const [name, c] of Object.entries(CONFIGS)) expect(configSchema.safeParse(c).success, name).toBe(true);
  });

  it("accepts every rule pack written out as a config", () => {
    for (const pack of Object.values(RULE_PACKS)) {
      const c = { version: pack.key, actions: { "*": { key: "*", risk: "hard_to_reverse" } }, rules: pack.rules, promotion: pack.promotion, lapsedPolicy: pack.lapsedPolicy };
      expect(ok(JSON.parse(JSON.stringify(c))), pack.key).toEqual({ valid: true, errors: [] });
    }
  });

  it("accepts a `$schema` line so editors can find it", () => {
    expect(ok({ $schema: "./config.schema.json", version: "v1", actions: {} }).valid).toBe(true);
  });

  const base = { version: "v1", actions: { "email.send": { key: "email.send", risk: "reversible_shared" } } };
  const bad: [string, unknown][] = [
    ["no actions", { version: "v1" }],
    ["blank version", { ...base, version: "" }],
    ["level 6", { ...base, actions: { a: { key: "a", risk: "irreversible", ceiling: 6 } } }],
    ["unknown risk class", { ...base, actions: { a: { key: "a", risk: "risky" } } }],
    ["a typo in an action field", { ...base, actions: { a: { key: "a", risk: "irreversible", alwaysAks: true } } }],
    ["an unknown top-level field", { ...base, flagz: {} }],
    ["an unknown rule type", { ...base, rules: [{ type: "vibes" }] }],
    ["a magnitude rule without a field", { ...base, rules: [{ type: "magnitude", max: 100 }] }],
    ["a cap lapsed rule without a level", { ...base, lapsedPolicy: { default: { outcome: "cap" } } }],
    ["a policy that allows", { ...base, policies: [{ id: "p", effect: "allow" }] }],
    ["experiment traffic over 100", { ...base, experiments: [{ key: "e", status: "running", arms: [], traffic: 150 }] }],
    ["a promotion rate over 1", { ...base, promotion: { irreversible: { minRate: 1.5 } } }],
    ["a plan ceiling for an unknown risk class", { ...base, plans: { free: { key: "free", features: {}, ceilings: { risky: 2 } } } }],
    ["a flag serving two ways at once", { ...base, flags: { f: { key: "f", on: true, variations: [true], offVariation: 0, fallthrough: { variation: 0, rollout: { variations: [] } } } } }],
  ];
  it.each(bad)("rejects %s, in JSON and in zod alike", (_, c) => {
    expect(ok(c).valid).toBe(false);
    expect(configSchema.safeParse(c).success).toBe(false);
  });
});
