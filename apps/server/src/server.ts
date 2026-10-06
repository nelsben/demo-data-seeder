// apps/server/src/server.ts
//
// Dev/prod entrypoint: build the app and listen. Port from PORT (default 8787).
// `pnpm --filter @dataseed/server dev` runs this under tsx watch.

import "./load-env.js"; // FIRST: load the repo-root .env before the providers read process.env
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp();
app
  .listen({ port, host })
  .then(() => console.log(`dataseed API on http://${host}:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
