import { describe, expect, it } from "vitest";
import { assignArm, evaluateExperiments, type Experiment } from "../src/index.js";

const exp: Experiment = {
  key: "auto-accept",
  status: "running",
  traffic: 100,
  actions: ["calendar.*"],
  arms: [
    { key: "control", weight: 50, autonomyCap: 1 },
    { key: "l3", weight: 50, autonomyCap: 3 },
  ],
};
const ctx = (key: string) => ({ subject: { key } });

describe("experiments", () => {
  it("assigns deterministically with roughly the right split", () => {
    let control = 0;
    for (let i = 0; i < 4000; i++) {
      const arm = assignArm(exp, ctx(`u${i}`))!;
      expect(assignArm(exp, ctx(`u${i}`))!.key).toBe(arm.key);
      if (arm.key === "control") control++;
    }
    expect(control / 4000).toBeGreaterThan(0.46);
    expect(control / 4000).toBeLessThan(0.54);
  });

  it("caps the level by arm and reports exposure", () => {
    const out = evaluateExperiments({ experiments: [exp] }, ctx("u1"), "calendar.accept");
    expect(out.exposures).toHaveLength(1);
    expect(out.binding).toBe(`experiment:auto-accept/${out.exposures[0]!.arm}`);
    expect([1, 3]).toContain(out.cap);
  });

  it("ignores other actions, stopped experiments and partial traffic", () => {
    expect(evaluateExperiments({ experiments: [exp] }, ctx("u1"), "email.send").exposures).toEqual([]);
    expect(assignArm({ ...exp, status: "stopped" }, ctx("u1"))).toBeNull();
    let enrolled = 0;
    for (let i = 0; i < 2000; i++) if (assignArm({ ...exp, traffic: 25 }, ctx(`u${i}`))) enrolled++;
    expect(enrolled / 2000).toBeGreaterThan(0.21);
    expect(enrolled / 2000).toBeLessThan(0.29);
  });

  it("ramping traffic does not reshuffle arms", () => {
    for (let i = 0; i < 500; i++) {
      const small = assignArm({ ...exp, traffic: 10 }, ctx(`u${i}`));
      if (small) expect(assignArm(exp, ctx(`u${i}`))!.key).toBe(small.key);
    }
  });

  it("keeps layer experiments mutually exclusive", () => {
    const a: Experiment = { ...exp, key: "a", layer: "L" };
    const b: Experiment = { ...exp, key: "b", layer: "L" };
    const layers = [{ key: "L", allocations: [{ experiment: "a", start: 0, end: 50 }, { experiment: "b", start: 50, end: 100 }] }];
    for (let i = 0; i < 500; i++) {
      const out = evaluateExperiments({ experiments: [a, b], layers }, ctx(`u${i}`), "calendar.accept");
      expect(out.exposures).toHaveLength(1);
    }
  });

  it("holds out subjects from every experiment and applies the holdout cap", () => {
    const holdouts = [{ key: "global", percent: 100, autonomyCap: 1 as const }];
    const out = evaluateExperiments({ experiments: [exp], holdouts }, ctx("u1"), "calendar.accept");
    expect(out).toMatchObject({ cap: 1, binding: "holdout:global", heldOut: "global", assignments: [] });
    expect(out.exposures).toEqual([{ experiment: "global", arm: "holdout", holdout: true }]);
  });
});
