// packages/core/src/sizing.ts
//
// The SIZE RESOLVER — turn ANY of the units an agent might think in ("give me 1,000 accounts" / "100k
// records" / "fill 20% of storage" / "leave 80% free" / "use it all") into the one internal knob the
// generator needs: a bulk-account `population`. It's pure + domain-agnostic (the per-account record model
// is passed in, so core stays pack-agnostic), so arbitrary callers (MCP agents) get a predictable, explainable
// translation instead of having to know the generator's internals.
//
// The conversion chain is: a size request → a TARGET RECORD COUNT → a population. Storage units need the
// org's live data-storage facts (maxMB/remainingMB); record/account units don't.

/** ~2KB per standard Salesforce record → 512 records per MB of data storage. The platform's storage unit. */
export const RECORDS_PER_MB = 512;

/**
 * A flexible "how much data" request — an agent supplies ONE unit; the resolver converts it to a bulk
 * account `population`. Precedence when several are set (first wins): population > accounts > records >
 * storageMB > storagePct > leaveFreePct. (To fill ALL remaining storage, pass `storagePct: 100`.)
 */
export interface SizeRequest {
  /** Direct bulk-account count (the internal knob; no conversion). */
  population?: number;
  /** Target TOTAL accounts (foreground volume + bulk population) → population = max(0, accounts − volume). */
  accounts?: number;
  /** Target TOTAL record count across all objects → back-solved to a population. */
  records?: number;
  /** Target data-storage footprint in MB → records → population. */
  storageMB?: number;
  /** Fill up to this % of the org's TOTAL data storage (accounts for what's already used). Needs org storage facts. (100 = use all remaining.) */
  storagePct?: number;
  /** Leave this % of the org's TOTAL data storage free (= fill 100 − leaveFreePct). Needs org storage facts. */
  leaveFreePct?: number;
}

/** The per-unit record model the resolver inverts to turn a record/storage target into a bulk account count. */
export interface SizeModel {
  /** Foreground deals already chosen — their records come off the top of a total-records/storage target. */
  volume: number;
  /** Records per foreground deal (pack.recordsPerUnitEstimate). */
  recordsPerForegroundUnit: number;
  /** Records per bulk account at the chosen bulkDensity (the plan's bulkEstimate; clamped > 0). */
  recordsPerBulkAccount: number;
  /** Once-seeded flat catalog (user pool, products, campaigns) — subtracted from a total target. Default 0. */
  flatRecords?: number;
}

/** The org's data-storage envelope (from the CapabilityProfile's limits.dataStorageMB). */
export interface OrgStorage {
  maxMB: number;
  remainingMB: number;
}

export interface ResolvedSize {
  /** The resolved bulk-account count to plan. */
  population: number;
  /** Which input drove the result ("population" | "accounts" | "records" | "storageMB" | "storagePct" | "leaveFreePct" | "fill" | "none"). */
  unit: string;
  /** The record target it back-solved from (record/storage units only). */
  targetRecords?: number;
  /** A human-readable trace of the resolution + any degradation (e.g. storage requested with no profile). */
  notes: string[];
}

const recordsToPopulation = (targetRecords: number, m: SizeModel): number => {
  const bulkRecords = targetRecords - m.volume * m.recordsPerForegroundUnit - (m.flatRecords ?? 0);
  return Math.max(0, Math.round(Math.max(0, bulkRecords) / Math.max(1, m.recordsPerBulkAccount)));
};

const r = (n: number) => Math.round(n);

/**
 * Resolve a flexible size request to a bulk-account `population`. Pure: same inputs → same output.
 * Storage-relative units (storagePct/leaveFreePct/fill) require `storage`; without it they degrade to
 * population 0 with an explanatory note (never throw — an arbitrary caller shouldn't crash the server).
 */
export function resolveSize(req: SizeRequest, model: SizeModel, storage?: OrgStorage): ResolvedSize {
  const notes: string[] = [];

  // 1. Direct counts — no conversion.
  if (req.population != null) return { population: Math.max(0, Math.floor(req.population)), unit: "population", notes };
  if (req.accounts != null) {
    const population = Math.max(0, Math.floor(req.accounts) - model.volume);
    return { population, unit: "accounts", notes: [`accounts ${req.accounts} − volume ${model.volume} → population ${population}`] };
  }

  // 2. Record / storage targets → a TARGET RECORD COUNT.
  let targetRecords: number;
  let unit: string;
  if (req.records != null) {
    targetRecords = Math.max(0, req.records);
    unit = "records";
  } else if (req.storageMB != null) {
    targetRecords = Math.max(0, req.storageMB) * RECORDS_PER_MB;
    unit = "storageMB";
    notes.push(`${req.storageMB}MB × ${RECORDS_PER_MB}/MB → ${r(targetRecords)} records`);
  } else if (req.storagePct != null || req.leaveFreePct != null) {
    unit = req.storagePct != null ? "storagePct" : "leaveFreePct";
    if (!storage) {
      notes.push(`${unit} requested but the org has no data-storage profile (synthetic/unprofiled) — cannot size by storage; population 0. Profile a live org, or size by accounts/records.`);
      return { population: 0, unit, notes };
    }
    const usedMB = Math.max(0, storage.maxMB - storage.remainingMB);
    const fillPct = Math.max(0, Math.min(100, req.storagePct != null ? req.storagePct : 100 - (req.leaveFreePct as number)));
    const targetUsedMB = storage.maxMB * (fillPct / 100);
    const addableMB = Math.max(0, targetUsedMB - usedMB);
    targetRecords = addableMB * RECORDS_PER_MB;
    notes.push(`${unit}: fill to ${fillPct}% of ${r(storage.maxMB)}MB = ${r(targetUsedMB)}MB; ${r(usedMB)}MB already used → ${r(addableMB)}MB addable × ${RECORDS_PER_MB}/MB → ${r(targetRecords)} records`);
  } else {
    return { population: 0, unit: "none", notes: ["no size unit given → population 0 (foreground deals only)"] };
  }

  const population = recordsToPopulation(targetRecords, model);
  notes.push(`${r(targetRecords)} records − ${model.volume} deals × ${model.recordsPerForegroundUnit} − ${model.flatRecords ?? 0} flat → ÷ ${model.recordsPerBulkAccount}/acct → population ${population}`);
  return { population, unit, targetRecords, notes };
}
