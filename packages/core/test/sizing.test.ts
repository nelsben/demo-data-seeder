import { describe, it, expect } from "vitest";
import { resolveSize, RECORDS_PER_MB, type SizeModel, type OrgStorage } from "@dataseed/core";

// The size resolver is the front door for arbitrary agent callers — it must turn whatever unit they think in
// (accounts / records / storage%) into a predictable bulk `population`, and degrade safely (never throw) when a
// storage unit is asked for without org storage facts.

const MODEL: SizeModel = { volume: 10, recordsPerForegroundUnit: 24, recordsPerBulkAccount: 10, flatRecords: 0 };
const FRESH: OrgStorage = { maxMB: 1000, remainingMB: 1000 }; // 0 used
const USED: OrgStorage = { maxMB: 1000, remainingMB: 600 }; // 400 MB already used

describe("resolveSize — flexible sizing units → a bulk population", () => {
  it("RECORDS_PER_MB is the platform storage constant", () => {
    expect(RECORDS_PER_MB).toBe(512);
  });

  it("population passes through directly", () => {
    expect(resolveSize({ population: 1234 }, MODEL).population).toBe(1234);
  });

  it("accounts back-solves population = accounts − volume", () => {
    const r = resolveSize({ accounts: 1000 }, MODEL);
    expect(r.unit).toBe("accounts");
    expect(r.population).toBe(990);
  });

  it("records subtracts the foreground cost then divides by per-account cost", () => {
    // (10000 − 10×24) / 10 = 9760 / 10 = 976
    expect(resolveSize({ records: 10_000 }, MODEL).population).toBe(976);
  });

  it("storageMB converts MB → records (×512) → population", () => {
    // 100MB × 512 = 51200 records; (51200 − 240) / 10 = 5096
    const r = resolveSize({ storageMB: 100 }, MODEL);
    expect(r.unit).toBe("storageMB");
    expect(r.population).toBe(5096);
  });

  it("storagePct fills to a % of TOTAL storage on a fresh org", () => {
    // 20% of 1000MB = 200MB addable → 102400 records → (102400 − 240)/10 = 10216
    expect(resolveSize({ storagePct: 20 }, MODEL, FRESH).population).toBe(10216);
  });

  it("leaveFreePct 80 == storagePct 20", () => {
    expect(resolveSize({ leaveFreePct: 80 }, MODEL, FRESH).population).toBe(resolveSize({ storagePct: 20 }, MODEL, FRESH).population);
  });

  it("storagePct accounts for what's ALREADY used", () => {
    // target 50% of 1000 = 500MB; 400MB used → 100MB addable → 51200 records → 5096
    expect(resolveSize({ storagePct: 50 }, MODEL, USED).population).toBe(5096);
  });

  it("a storage target already exceeded yields population 0 (no negative)", () => {
    // want to fill to 30% (=300MB) but 400MB already used → 0 addable
    expect(resolveSize({ storagePct: 30 }, MODEL, USED).population).toBe(0);
  });

  it("storage units WITHOUT org storage facts degrade to 0 with a note (never throw)", () => {
    const r = resolveSize({ storagePct: 20 }, MODEL); // no storage arg
    expect(r.population).toBe(0);
    expect(r.unit).toBe("storagePct");
    expect(r.notes.join(" ")).toMatch(/no data-storage profile/i);
  });

  it("precedence: population > accounts > records", () => {
    expect(resolveSize({ population: 5, accounts: 9999, records: 9999 }, MODEL).unit).toBe("population");
    expect(resolveSize({ accounts: 100, records: 9999 }, MODEL).unit).toBe("accounts");
  });

  it("no size unit → population 0 (foreground only)", () => {
    const r = resolveSize({}, MODEL);
    expect(r.population).toBe(0);
    expect(r.unit).toBe("none");
  });

  it("is pure — same request → same result", () => {
    const a = resolveSize({ storagePct: 35 }, MODEL, USED);
    const b = resolveSize({ storagePct: 35 }, MODEL, USED);
    expect(a.population).toBe(b.population);
  });
});
