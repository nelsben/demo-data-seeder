// apps/server/src/registry.ts
//
// The server's composition root — like apps/cli, the one place engine + packs meet.
// Builds the PackRegistry the routes resolve packs from. New pack = one line.

import { PackRegistry } from "@dataseed/core";
import { salescloudPack } from "@dataseed/pack-salescloud";

export function buildRegistry(): PackRegistry {
  return new PackRegistry().register(salescloudPack);
}
