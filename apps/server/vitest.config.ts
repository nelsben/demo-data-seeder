import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server's routes persist state under a cwd-derived `.dataseed/` dir, and each
    // test file cleans it in afterAll. Run files sequentially so one file's teardown
    // can't delete another file's fixtures mid-run (the load/teardown lifecycle race).
    fileParallelism: false,
  },
});
