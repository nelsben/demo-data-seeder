import { describe, it, expect } from "vitest";
import { coerce } from "@dataseed/engine";

// CLI arg coercion. Regression: an integer-only regex silently rejected fractional values, so a documented
// knob like `--bulkDensity 0.6` fell through as the string "0.6" → ScopeParams NaN. Decimals must coerce.
describe("CLI coerce — arg string → typed value", () => {
  it("coerces integers AND decimals to numbers (--bulkDensity 0.6 regression)", () => {
    expect(coerce("0.6")).toBe(0.6); // was rejected → stayed a string → NaN downstream
    expect(coerce("100000")).toBe(100000);
    expect(coerce("-3")).toBe(-3);
    expect(coerce("1.5")).toBe(1.5);
  });

  it("leaves non-numeric strings as strings (seeds, names)", () => {
    expect(coerce("demo-q3")).toBe("demo-q3");
    expect(coerce("1.2.3")).toBe("1.2.3"); // version-like → not a number
    expect(coerce("abc")).toBe("abc");
  });

  it("coerces booleans and comma-lists", () => {
    expect(coerce("true")).toBe(true);
    expect(coerce("false")).toBe(false);
    expect(coerce("a,b,c")).toEqual(["a", "b", "c"]);
  });
});
