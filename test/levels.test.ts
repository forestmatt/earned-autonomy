import { describe, expect, it } from "vitest";
import { clampLevel, effectiveLevel, verdictFor } from "../src/index.js";

describe("effectiveLevel", () => {
  it("is the min of the four and names the binding input", () => {
    expect(effectiveLevel({ earned: 3, ceiling: 4, rollout: 5, experiment: 2 })).toEqual({ level: 2, binding: "experiment" });
    expect(effectiveLevel({ earned: 1, ceiling: 4, rollout: 5, experiment: 5 })).toEqual({ level: 1, binding: "earned" });
    expect(effectiveLevel({ earned: 5, ceiling: 5, rollout: 3, experiment: 5 })).toEqual({ level: 3, binding: "rollout" });
  });

  it("prefers a builder limit over the track record on a tie", () => {
    expect(effectiveLevel({ earned: 3, ceiling: 3, rollout: 5, experiment: 5 }).binding).toBe("ceiling");
    expect(effectiveLevel({ earned: 2, ceiling: 5, rollout: 5, experiment: 2 }).binding).toBe("experiment");
  });
});

describe("verdictFor", () => {
  it("maps L0 and L1 to ask, L2 and up to allow", () => {
    expect([0, 1, 2, 3, 4, 5].map((l) => verdictFor(l as 0))).toEqual(["ask", "ask", "allow", "allow", "allow", "allow"]);
  });

  it("clamps", () => {
    expect(clampLevel(9)).toBe(5);
    expect(clampLevel(-1)).toBe(0);
    expect(clampLevel(Number.NaN)).toBe(0);
  });
});
