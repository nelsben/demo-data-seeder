import { describe, it, expect } from "vitest";
import { apportion, assignByMix, expandCounts, backdateIso, spreadDates } from "../src/sample.js";
import { makeRng } from "../src/rng.js";

describe("apportion (largest-remainder)", () => {
  it("sums EXACTLY to total even with awkward percentages", () => {
    const out = apportion(12, [34, 33, 33]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(12);
    // 4.08/3.96/3.96 → floors 4/3/3; the two 0.96 remainders win the 2 leftovers (0.08 loses)
    expect(out).toEqual([4, 4, 4]);
  });

  it("handles total=0 and all-zero weights", () => {
    expect(apportion(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(apportion(5, [0, 0]).reduce((a, b) => a + b, 0)).toBe(5); // even-ish spread
  });

  it("never produces negatives and respects a single bucket", () => {
    expect(apportion(7, [1])).toEqual([7]);
  });
});

describe("assignByMix + expandCounts", () => {
  it("maps a named mix to exact counts and expands deterministically", () => {
    const counts = assignByMix(10, { a: 50, b: 30, c: 20 });
    expect(counts).toEqual({ a: 5, b: 3, c: 2 });
    const flat = expandCounts(counts);
    expect(flat).toHaveLength(10);
    expect(flat.filter((x) => x === "a")).toHaveLength(5);
    expect(flat.slice(0, 5).every((x) => x === "a")).toBe(true); // grouped, ordered
  });
});

describe("backdateIso", () => {
  it("subtracts whole days from an injected anchor (pure)", () => {
    expect(backdateIso("2026-06-17T00:00:00.000Z", 7)).toBe("2026-06-10T00:00:00.000Z");
  });
});

describe("spreadDates", () => {
  const asOf = "2026-06-17T00:00:00.000Z";
  const within = (iso: string, spanDays: number) => {
    const ageDays = (new Date(asOf).getTime() - new Date(iso).getTime()) / 86_400_000;
    return ageDays >= -0.001 && ageDays <= spanDays + 0.001;
  };

  it("returns `count` timestamps, oldest-first, all within the span", () => {
    const dates = spreadDates(makeRng(1), asOf, 6, { spanDays: 45 });
    expect(dates).toHaveLength(6);
    expect(dates.every((d) => within(d, 45))).toBe(true);
    const times = dates.map((d) => new Date(d).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b)); // ascending = oldest first
  });

  it("is deterministic for a given seed", () => {
    expect(spreadDates(makeRng(7), asOf, 5, { spanDays: 30, shape: "accelerating" })).toEqual(
      spreadDates(makeRng(7), asOf, 5, { spanDays: 30, shape: "accelerating" }),
    );
  });

  it("'accelerating' skews newer than 'stalling' on average", () => {
    const avgAge = (shape: "accelerating" | "stalling") => {
      const ds = spreadDates(makeRng(3), asOf, 8, { spanDays: 60, shape });
      const ages = ds.map((d) => (new Date(asOf).getTime() - new Date(d).getTime()) / 86_400_000);
      return ages.reduce((a, b) => a + b, 0) / ages.length;
    };
    expect(avgAge("accelerating")).toBeLessThan(avgAge("stalling"));
  });

  it("count<=0 yields an empty array", () => {
    expect(spreadDates(makeRng(1), asOf, 0, { spanDays: 10 })).toEqual([]);
  });
});
