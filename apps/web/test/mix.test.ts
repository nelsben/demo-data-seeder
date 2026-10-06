import { describe, it, expect } from "vitest";
import { mixTotal, mixIsValid, evenMix } from "../src/mix.js";

describe("scenario-mix helpers", () => {
  it("sums and validates the 100 invariant", () => {
    expect(mixTotal({ a: 34, b: 33, c: 33 })).toBe(100);
    expect(mixIsValid({ a: 34, b: 33, c: 33 })).toBe(true);
    expect(mixIsValid({ a: 50, b: 40 })).toBe(false);
    expect(mixIsValid({})).toBe(false);
    expect(mixIsValid({ a: -10, b: 110 })).toBe(false);
  });

  it("evenMix splits to exactly 100 with the remainder to the earliest scenarios", () => {
    expect(evenMix(["a", "b", "c"])).toEqual({ a: 34, b: 33, c: 33 });
    expect(mixTotal(evenMix(["a", "b", "c", "d", "e", "f", "g"]))).toBe(100);
    expect(evenMix([])).toEqual({});
  });
});
