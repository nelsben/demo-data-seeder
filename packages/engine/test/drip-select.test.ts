import { describe, it, expect } from "vitest";
import { selectDayPlan, arcMotionWeight, type SelectDayPlanOptions } from "../src/drip/select.js";
import type { DripCandidate } from "../src/drip/types.js";

const candidate = (over: Partial<DripCandidate>): DripCandidate => ({
  oppId: "006AAA",
  oppName: "Acme — Platform",
  accountId: "001AAA",
  accountName: "Acme",
  arc: "unknown",
  lastInteractionDate: "2026-08-01",
  ...over,
});

describe("selectDayPlan — deterministic day plan", () => {
  it("same seed + day + candidates → same picks, every call", () => {
    const candidates = [
      candidate({ oppId: "006A", lastInteractionDate: "2026-08-01" }),
      candidate({ oppId: "006B", lastInteractionDate: "2026-08-15" }),
      candidate({ oppId: "006C", lastInteractionDate: "2026-07-01" }),
      candidate({ oppId: "006D", lastInteractionDate: "2026-08-20" }),
    ];
    const opts: SelectDayPlanOptions = { seed: "demo-42", day: "2026-09-04", accounts: 2 };
    const first = selectDayPlan(candidates, opts);
    const second = selectDayPlan(candidates, opts);
    expect(first.map((c) => c.oppId)).toEqual(second.map((c) => c.oppId));
    // A third call with the SAME seed but a freshly-built (new object identity) candidate array still agrees.
    const third = selectDayPlan([...candidates], { ...opts });
    expect(third.map((c) => c.oppId)).toEqual(first.map((c) => c.oppId));
  });

  it("prefers the deal with the OLDEST last-interaction date first", () => {
    const candidates = [
      candidate({ oppId: "006-fresh", lastInteractionDate: "2026-09-01" }), // 3 days old
      candidate({ oppId: "006-stale", lastInteractionDate: "2026-07-01" }), // ~2 months old
      candidate({ oppId: "006-mid", lastInteractionDate: "2026-08-15" }),
    ];
    const picks = selectDayPlan(candidates, { seed: 1, day: "2026-09-04", accounts: 1 });
    expect(picks).toHaveLength(1);
    expect(picks[0]!.oppId).toBe("006-stale");
  });

  it("never returns more than --accounts, even with many eligible candidates", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate({ oppId: `006-${i}`, lastInteractionDate: `2026-0${(i % 9) + 1}-01` }));
    const picks = selectDayPlan(candidates, { seed: "s", day: "2026-09-04", accounts: 3 });
    expect(picks.length).toBeLessThanOrEqual(3);
    expect(picks).toHaveLength(3);
  });

  it("returns [] for accounts <= 0 or an empty candidate list — never throws", () => {
    expect(selectDayPlan([candidate({})], { seed: 1, day: "2026-09-04", accounts: 0 })).toEqual([]);
    expect(selectDayPlan([], { seed: 1, day: "2026-09-04", accounts: 5 })).toEqual([]);
  });

  it("weights an arc that wants regular motion above one meant to read quiet (stalled-portfolio)", () => {
    expect(arcMotionWeight("at-risk-budget")).toBeGreaterThan(arcMotionWeight("stalled-portfolio"));
    // Same last-interaction date, different arc — the higher-motion arc wins the tiebreak.
    const candidates = [candidate({ oppId: "006-quiet", arc: "stalled-portfolio", lastInteractionDate: "2026-08-01" }), candidate({ oppId: "006-urgent", arc: "at-risk-budget", lastInteractionDate: "2026-08-01" })];
    const picks = selectDayPlan(candidates, { seed: "x", day: "2026-09-04", accounts: 1 });
    expect(picks[0]!.oppId).toBe("006-urgent");
  });
});
