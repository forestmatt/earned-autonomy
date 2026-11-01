// TextEncoder is global in Node and Workers, but not in the ES2022 lib.
declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };
import { describe, expect, it } from "vitest";
import { bucket, canonicalJson, fnv1a32, hashOf, inPercent, utf8 } from "../src/index.js";

describe("fnv1a32", () => {
  // Standard FNV-1a 32 test vectors.
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("hashes %j", (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });

  it("encodes UTF-8 like TextEncoder", () => {
    for (const s of ["héllo", "日本", "🚀 go", "a\u0000b"]) {
      expect(utf8(s)).toEqual([...new TextEncoder().encode(s)]);
    }
  });
});

describe("bucket", () => {
  // Published test vectors. If these change, every SDK disagrees, so never
  // change them without a spec version bump.
  it.each([
    ["checkout", "user_1", 432],
    ["checkout", "user_2", 6038],
    ["inbox-send", "user_123", 328],
    ["", "", 4581],
  ])("bucket(%j, %j) is %i", (salt, key, expected) => {
    expect(bucket(salt, key)).toBe(expected);
  });

  it("is in range and spreads evenly", () => {
    const counts = Array.from({ length: 10 }, () => 0);
    for (let i = 0; i < 20_000; i++) {
      const b = bucket("salt", `user_${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10_000);
      counts[Math.floor(b / 1000)]!++;
    }
    for (const c of counts) expect(c).toBeGreaterThan(1700);
    for (const c of counts) expect(c).toBeLessThan(2300);
  });

  it("inPercent matches the rough share and handles the edges", () => {
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (inPercent("ramp", `s${i}`, 20)) hits++;
    expect(hits).toBeGreaterThan(1800);
    expect(hits).toBeLessThan(2200);
    expect(inPercent("x", "y", 0)).toBe(false);
    expect(inPercent("x", "y", 100)).toBe(true);
  });

  it("ramping up keeps everyone already in", () => {
    for (let i = 0; i < 1000; i++) {
      if (inPercent("ramp", `s${i}`, 10)) expect(inPercent("ramp", `s${i}`, 30)).toBe(true);
    }
  });
});

describe("canonicalJson", () => {
  it("sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
});
