// packages/engine/src/ops/example.ts
//
// A side-effect-free example op (check/run/verify only log). Kept so the CLI +
// op-contract are smoke-testable in CI with NO Salesforce org. Mirrors the old
// ops/00-example.mjs lifecycle, now TS.

import type { Op } from "./types.js";

export const exampleOp: Op = {
  id: "example",
  name: "Example op",
  description: "A no-op that exercises the validate→check→run→verify lifecycle. Safe to run anywhere (logs only).",
  idempotent: true,
  affects: [],
  prerequisites: [],
  args: {
    companies: { type: "number", default: 3, description: "Pretend count of companies to generate (logged only)." },
  },
  check(args, ctx) {
    ctx.log(`check: would generate ${args.companies} companies`);
    return { alreadyDone: false };
  },
  run(args, ctx) {
    ctx.log(`run: generating ${args.companies} companies (no-op)`);
  },
  verify(args, ctx) {
    ctx.log("verify: ok");
    return { success: true, companies: args.companies };
  },
};

export default exampleOp;
