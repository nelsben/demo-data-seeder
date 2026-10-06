import { describe, it, expect } from "vitest";
import { makeRng, deriveSeed, seedFromString, mulberry32 } from "../src/rng.js";

describe("mulberry32 / makeRng determinism", () => {
  it("same seed ⇒ byte-identical stream (the reproducibility contract)", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds ⇒ different streams", () => {
    const a = Array.from({ length: 10 }, () => makeRng(1).next());
    const b = Array.from({ length: 10 }, () => makeRng(2).next());
    expect(a).not.toEqual(b);
  });

  it("is stable across Node versions/platforms (pinned golden values)", () => {
    // Locks the algorithm: if these change, determinism (and committed snapshots) break.
    const r = mulberry32(42);
    expect(r().toFixed(12)).toBe("0.601103751920");
    expect(r().toFixed(12)).toBe("0.448290558998");
  });
});

describe("rng helpers", () => {
  it("int is inclusive and within bounds", () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it("weighted respects weights over many draws", () => {
    const r = makeRng(99);
    let x = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      if (r.weighted([{ value: "x", weight: 3 }, { value: "y", weight: 1 }]) === "x") x++;
    }
    expect(x / N).toBeGreaterThan(0.68); // ~0.75 expected
    expect(x / N).toBeLessThan(0.82);
  });

  it("shuffle does not mutate the input and preserves the multiset", () => {
    const r = makeRng(5);
    const input = [1, 2, 3, 4, 5];
    const out = r.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("pick/weighted throw on empty input", () => {
    const r = makeRng(1);
    expect(() => r.pick([])).toThrow();
    expect(() => r.weighted([])).toThrow();
  });
});

describe("deriveSeed / seedFromString", () => {
  it("deriveSeed is stable and order-sensitive", () => {
    expect(deriveSeed(42, "stage")).toBe(deriveSeed(42, "stage"));
    expect(deriveSeed(42, "a", "b")).not.toBe(deriveSeed(42, "b", "a"));
    expect(deriveSeed(42, "ab", "c")).not.toBe(deriveSeed(42, "a", "bc"));
  });

  it("derive yields an independent child stream that does not perturb the parent", () => {
    const parent = makeRng(42);
    const firstParentDraw = parent.next();

    const p2 = makeRng(42);
    p2.derive("accounts", 3).int(0, 100); // consume from a child
    const firstParentDraw2 = p2.next();

    // The parent's own stream is unaffected by draws taken from a derived child.
    expect(firstParentDraw2).toBe(firstParentDraw);
  });

  it("seedFromString hashes a memorable name to a uint32", () => {
    const s = seedFromString("meridian-q3");
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
    expect(seedFromString("meridian-q3")).toBe(s); // stable
  });
});
