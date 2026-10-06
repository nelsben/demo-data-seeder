// apps/cli/src/main.ts
//
// The composition root for the CLI. This is the ONE place engine + packs meet:
// it builds the PackRegistry (registering every shipped target pack) and hands it
// to the engine's op-runner. The engine stays pack-agnostic; packs never import
// the engine. New pack ⇒ one register() line here, nothing else.
//
// Invoked by the root run-op.js shim (tsx-registered) and by `pnpm op`.

import { PackRegistry } from "@dataseed/core";
import { run, EXIT } from "@dataseed/engine";
import { salescloudPack } from "@dataseed/pack-salescloud";

export function buildRegistry(): PackRegistry {
  return new PackRegistry().register(salescloudPack);
  // future: .register(otherPack)
}

export async function main(argv: string[]): Promise<number> {
  return run(argv, buildRegistry());
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(EXIT.UNCAUGHT);
  });
