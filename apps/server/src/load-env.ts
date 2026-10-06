// apps/server/src/load-env.ts
//
// Loads the gitignored repo-root .env (ANTHROPIC_API_KEY, etc.) before anything reads
// process.env. Imported FIRST by server.ts (import order = execution order), so the copy
// providers see the key. Resolves the monorepo root from this file's location, so it works
// regardless of cwd (pnpm --filter runs the server with cwd = the package dir, not the root).

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // apps/server/src → repo root
dotenv.config({ path: join(root, ".env") });
