// packages/engine/src/store/warehouse-slice.ts
//
// The warehouse→org BRIDGE (read side). A materialized 100K corpus lives in the warehouse (one SQLite table
// per sObject, never held whole in memory), but a Dev/scratch org can't physically hold 100K accounts (data-
// storage caps) — and you rarely want it to. The realistic need is to land a BOUNDED, account-rooted SLICE
// of the corpus into an org through the existing, proven loader (`loadBundle`).
//
// buildWarehouseSlice assembles a closed NarrativeBundle-shaped record set by walking the pack's load order
// and keeping an `included` ref-set:
//   • objects BEFORE Account in load order are the shared SCAFFOLD (Product2/PricebookEntry/Campaign/User/
//     UserRole) → loaded wholesale (they're small and every account's subtree points at them);
//   • Account → the first N (emit order);
//   • Lead → the first M (the funnel top is account-INDEPENDENT — no parent_ref — so it's sliced on its own);
//   • every other object → rows whose `parent_ref` ∈ included (Contact/Opp under their Account, OCR/OLI/
//     Email/Task/Event/transcript under their Opp, Case/Asset under their Account, CaseComment under its
//     Case, CampaignMember under its Contact/Lead). The walk is parents-first, so each child's parent is
//     already in `included` when it's read — the slice is referentially CLOSED by construction.
// The result feeds loadBundle unchanged: it resolves the in-slice `_refs` exactly as it does for a foreground
// dataset (scaffold refs + the standard-pricebook sentinel all resolve because the scaffold is in the slice).

import type { BundleRecords, GenericRecord } from "@dataseed/core";
import type { WarehouseStore } from "@dataseed/warehouse";

export interface SliceOpts {
  /** Number of root Accounts to include (the slice size). Their full subtree comes along. */
  accounts: number;
  /** Number of net-new Leads (the account-independent funnel top) to include. 0 = none. */
  leads: number;
  /** Optional explicit set of Account `_ref`s to seed the slice with (e.g. a sentiment-filtered selection from
   *  select_accounts). When present, these replace the first-N emit-order sample; still capped by `accounts`. */
  accountRefs?: readonly string[];
}

export interface WarehouseSlice {
  records: BundleRecords;
  stats: {
    accounts: number;
    /** Per-object row count in the slice (in load order). */
    perObject: Record<string, number>;
    totalRecords: number;
  };
}

/**
 * Build a bounded, referentially-closed account-rooted slice of a warehouse corpus.
 * `loadOrder` is the pack's object order (scaffold first, Account, then the account-rooted graph);
 * `counts` is the corpus manifest's per-object counts (used to skip objects absent from this corpus).
 */
export function buildWarehouseSlice(
  store: WarehouseStore,
  dsId: string,
  loadOrder: readonly string[],
  counts: Record<string, number>,
  opts: SliceOpts,
): WarehouseSlice {
  const acctIdx = loadOrder.indexOf("Account");
  const records: BundleRecords = {};
  const perObject: Record<string, number> = {};
  const included = new Set<string>();
  const collect = (recs: readonly GenericRecord[]): void => {
    for (const r of recs) if (typeof r._ref === "string") included.add(r._ref);
  };

  for (let i = 0; i < loadOrder.length; i++) {
    const obj = loadOrder[i]!;
    if (!counts[obj]) continue; // object not present in this corpus — skip

    let recs: GenericRecord[];
    if (acctIdx >= 0 && i < acctIdx) {
      recs = store.readObject(dsId, obj); // shared scaffold — wholesale (small, referenced by every subtree)
    } else if (obj === "Account") {
      // A filtered selection (e.g. by sentiment) seeds the slice from explicit refs; otherwise first N by emit order.
      recs = opts.accountRefs
        ? store.readByRefs(dsId, obj, opts.accountRefs.slice(0, opts.accounts))
        : store.sample(dsId, obj, opts.accounts);
    } else if (obj === "Lead") {
      recs = opts.leads > 0 ? store.sample(dsId, obj, opts.leads) : []; // account-independent funnel top
    } else if (obj === "CampaignMember") {
      // A CampaignMember's MEMBER (Lead or Contact) is NOT always its parent_ref: the foreground funnel member
      // is keyed on its Campaign (scaffold, always included), so parent_ref membership alone would pull it into
      // every slice while its LeadId dangles (a member-less CM fails to load: "member id 'null'"). Enforce
      // closure on the member ref too — keep only CMs whose Lead OR Contact is actually in the slice.
      recs = store.readChildren(dsId, obj, [...included]).filter((r) => {
        const refs = (r._refs as Record<string, string> | undefined) ?? {};
        return (typeof refs.ContactId === "string" && included.has(refs.ContactId)) || (typeof refs.LeadId === "string" && included.has(refs.LeadId));
      });
    } else {
      recs = store.readChildren(dsId, obj, [...included]); // subtree by parent_ref membership
    }

    if (recs.length) {
      records[obj] = recs;
      collect(recs);
    }
    perObject[obj] = recs.length;
  }

  const totalRecords = Object.values(perObject).reduce((a, b) => a + b, 0);
  return { records, stats: { accounts: perObject.Account ?? 0, perObject, totalRecords } };
}
