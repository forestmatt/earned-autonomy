import { describe, expect, it } from "vitest";
import { bucket, decide, recordOutcome, type Config, type DecideInput, type DecideState, type Outcome, type TrustScope } from "../src/index.js";
import { BUCKET_CASES, CONFIGS, DECIDE_CASES, RECORD_CASES } from "./conformance.cases.js";

// JSON conformance vectors (ROADMAP, the open spec). conformance/vectors.json holds inputs and the
// outputs this engine gives, so another implementation can check itself from JSON alone.
// Regenerate with `UPDATE_CONFORMANCE=1 npx vitest run packages/core/test/conformance.test.ts`,
// and read the diff: a changed expectation is a behaviour change other implementations will see.

// Core has no Node types (it stays portable), so the two file calls are typed here.
type Fs = { readFileSync(p: URL, enc: "utf8"): string; writeFileSync(p: URL, s: string): void };
const fs = (await import("node:" + "fs")) as Fs;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const file = new URL("../conformance/vectors.json", import.meta.url);

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function generate() {
  return {
    spec: "earned-autonomy",
    version: 1,
    about: "Inputs and expected outputs for the earned-autonomy engine. See conformance/README.md.",
    configs: json(CONFIGS),
    decide: DECIDE_CASES.map((c) => ({ ...json(c), expect: json(decide(c.input, CONFIGS[c.config]!, c.state, c.options)) })),
    record: RECORD_CASES.map((c) => {
      let s = c.scope;
      const expect = c.steps.map((step) => {
        const r = recordOutcome(s, step.outcome, step.options);
        s = r.scope;
        return json(r);
      });
      return { ...json(c), expect };
    }),
    bucket: BUCKET_CASES.map((c) => ({ ...c, expect: bucket(c.salt, c.key) })),
  };
}

type Vectors = ReturnType<typeof generate>;
const text = JSON.stringify(generate(), null, 2) + "\n";
if (env.UPDATE_CONFORMANCE === "1") fs.writeFileSync(file, text);
const vectors = JSON.parse(fs.readFileSync(file, "utf8")) as Vectors;

describe("conformance vectors", () => {
  it("are up to date with the engine (UPDATE_CONFORMANCE=1 to regenerate, then read the diff)", () => {
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  it("cover every decision outcome and the main bindings", () => {
    const decisions = new Set(vectors.decide.map((v) => v.expect.decision));
    expect([...decisions].sort()).toEqual(["allow", "ask", "deny"]);
    const bindings = vectors.decide.map((v) => v.expect.binding.split(":")[0]);
    for (const b of ["earned", "policy", "entitlement", "rollout", "ceiling", "experiment", "forced", "tripwire", "error"]) expect(bindings, b).toContain(b);
    expect(vectors.decide.some((v) => v.expect.next === "request_promotion")).toBe(true);
    expect(vectors.record.some((v) => v.expect.some((r) => r.demoted))).toBe(true);
    expect(new Set(vectors.decide.map((v) => v.name)).size).toBe(vectors.decide.length);
    // Every named config is used.
    expect(new Set(vectors.decide.map((v) => v.config))).toEqual(new Set(Object.keys(vectors.configs)));
  });

  // What another implementation does. Load the JSON, run each case, compare.
  it.each(vectors.decide.map((v) => [v.name, v] as const))("decide: %s", (_, v) => {
    const config = vectors.configs[v.config] as Config | undefined;
    expect(config, v.config).toBeDefined();
    expect(json(decide(v.input as DecideInput, config!, v.state as DecideState, v.options))).toEqual(v.expect);
  });

  it.each(vectors.record.map((v) => [v.name, v] as const))("record: %s", (_, v) => {
    let s = v.scope as TrustScope;
    v.steps.forEach((step, i) => {
      const r = recordOutcome(s, step.outcome as Outcome, step.options);
      expect(json(r), `step ${i + 1}`).toEqual(v.expect[i]);
      s = r.scope;
    });
  });

  it("bucket matches the published vectors in test/hash.test.ts", () => {
    const published: Record<string, number> = { "checkout|user_1": 432, "checkout|user_2": 6038, "inbox-send|user_123": 328, "|": 4581 };
    for (const v of vectors.bucket) {
      expect(bucket(v.salt, v.key)).toBe(v.expect);
      const p = published[`${v.salt}|${v.key}`];
      if (p !== undefined) expect(v.expect).toBe(p);
    }
  });

  it("are plain JSON with no names or hosts in them (the package is public)", () => {
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toMatch(/throtl|matt|@(?!x\.com)[a-z]+\.[a-z]/i);
    expect(json(vectors)).toEqual(vectors);
  });
});
