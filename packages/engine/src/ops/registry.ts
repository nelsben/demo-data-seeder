// packages/engine/src/ops/registry.ts
//
// The static op registry. (Static, not filesystem-scanned: TS ops compile cleanly
// and the list stays explicit + tree-shakeable.) The CLI resolves ops from here.

import type { Op } from "./types.js";
import { exampleOp } from "./example.js";
import { profileOrgOp } from "./profile-org.js";
import { planDemoOp } from "./plan-demo.js";
import { fillCopyOp } from "./fill-copy.js";
import { loadDemoOp } from "./load-demo.js";
import { loadWarehouseOp } from "./load-warehouse.js";
import { disperseDemoOp } from "./disperse.js";
import { teardownDemoOp } from "./teardown-demo.js";
import { materializeOp } from "./materialize.js";
import { warehouseOp } from "./warehouse.js";
import { seedAccountOp } from "./seed-account.js";
import { storageOp } from "./storage.js";
import { purgeOp } from "./purge.js";
import { dripOp } from "./drip.js";

export const OPS: Op[] = [exampleOp, profileOrgOp, planDemoOp, seedAccountOp, materializeOp, warehouseOp, fillCopyOp, loadDemoOp, loadWarehouseOp, disperseDemoOp, teardownDemoOp, storageOp, purgeOp, dripOp];

export function findOp(id: string): Op | undefined {
  return OPS.find((o) => o.id === id);
}
